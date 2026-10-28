import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { isValidIdempotencyKey, requestFingerprint, validateSendRequest } from '../core/message';
import { httpRequests, idempotentReplays, messagesAccepted } from '../infra/metrics';
import { ApiKeyGuard } from './api-key.guard';
import { MessagesRepository } from './messages.repository';
import { ReceiptsRepository } from './receipts.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('v1/messages')
@UseGuards(ApiKeyGuard)
export class MessagesController {
  constructor(
    private readonly repository: MessagesRepository,
    private readonly receipts: ReceiptsRepository,
  ) {}

  /**
   * Accepts a message for asynchronous delivery.
   *
   * 202 with the new id; 200 with the original id when the same Idempotency-Key and payload
   * are sent again; 409 when the key was used for a different payload.
   *
   * The response is written by hand because the status depends on the outcome, and Nest's
   * default status handling would override it.
   */
  @Post()
  async send(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const validation = validateSendRequest(body);
    if (!validation.ok) {
      httpRequests.inc({ route: 'send', status: 400 });
      throw new BadRequestException({ message: 'invalid message', errors: validation.errors });
    }
    if (idempotencyKey !== undefined && !isValidIdempotencyKey(idempotencyKey)) {
      httpRequests.inc({ route: 'send', status: 400 });
      throw new BadRequestException('Idempotency-Key must be 8-128 characters of [A-Za-z0-9_-:.]');
    }

    const request = validation.value;
    if (await this.receipts.isSuppressed(request.channel, request.to)) {
      httpRequests.inc({ route: 'send', status: 422 });
      throw new UnprocessableEntityException(
        'recipient is suppressed after a hard bounce or a complaint; remove it from the suppression list to send again',
      );
    }
    const result = await this.repository.accept(request, requestFingerprint(request), idempotencyKey);

    switch (result.kind) {
      case 'created':
        messagesAccepted.inc({ channel: request.channel });
        httpRequests.inc({ route: 'send', status: 202 });
        res.status(202).json({ id: result.id, status: 'accepted' });
        return;
      case 'replayed':
        idempotentReplays.inc({ outcome: 'replayed' });
        httpRequests.inc({ route: 'send', status: 200 });
        res.status(200).setHeader('Idempotent-Replayed', 'true');
        res.json({ id: result.id, status: result.status });
        return;
      case 'conflict':
        idempotentReplays.inc({ outcome: 'conflict' });
        httpRequests.inc({ route: 'send', status: 409 });
        throw new ConflictException(`Idempotency-Key already used for a different message (${result.id})`);
    }
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    if (!UUID.test(id)) {
      httpRequests.inc({ route: 'get', status: 400 });
      throw new BadRequestException('id must be a UUID');
    }
    const message = await this.repository.find(id);
    httpRequests.inc({ route: 'get', status: message ? 200 : 404 });
    if (!message) throw new NotFoundException();
    return { ...message, receipts: await this.receipts.forMessage(id) };
  }
}
