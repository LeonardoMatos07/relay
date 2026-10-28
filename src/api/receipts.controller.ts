import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CHANNELS, type Channel } from '../core/message';
import { validateReceipt } from '../core/receipt';
import { httpRequests, receiptsRecorded } from '../infra/metrics';
import { ApiKeyGuard } from './api-key.guard';
import { ReceiptsRepository } from './receipts.repository';

@Controller('v1')
@UseGuards(ApiKeyGuard)
export class ReceiptsController {
  constructor(private readonly repository: ReceiptsRepository) {}

  /**
   * Accepts a delivery receipt, already normalized by whatever sits in front of the provider.
   *
   * 202 when it is new, 200 when the same receipt id was already recorded (the sender may retry
   * freely), 404 when no message matches, 400 when the body is not a receipt.
   */
  @Post('receipts')
  async receive(@Body() body: unknown, @Res() res: Response): Promise<void> {
    const validation = validateReceipt(body);
    if (!validation.ok) {
      httpRequests.inc({ route: 'receipt', status: 400 });
      throw new BadRequestException({ message: 'invalid receipt', errors: validation.errors });
    }
    const receipt = validation.value;
    const result = await this.repository.record(receipt);

    switch (result.kind) {
      case 'recorded':
        receiptsRecorded.inc({ provider: receipt.provider, type: receipt.type, outcome: 'recorded' });
        httpRequests.inc({ route: 'receipt', status: 202 });
        res.status(202).json({
          status: 'recorded',
          messageId: result.messageId,
          delivery: result.delivery,
          suppressed: result.suppressed,
        });
        return;
      case 'duplicate':
        receiptsRecorded.inc({ provider: receipt.provider, type: receipt.type, outcome: 'duplicate' });
        httpRequests.inc({ route: 'receipt', status: 200 });
        res.status(200).json({ status: 'duplicate', messageId: result.messageId });
        return;
      case 'unknown-message':
        receiptsRecorded.inc({ provider: receipt.provider, type: receipt.type, outcome: 'unknown' });
        httpRequests.inc({ route: 'receipt', status: 404 });
        throw new NotFoundException('no message matches this receipt');
    }
  }

  /** Lets an operator send to an address again after fixing the cause of the bounce. */
  @Delete('suppressions/:channel/:recipient')
  @HttpCode(204)
  async unsuppress(@Param('channel') channel: string, @Param('recipient') recipient: string): Promise<void> {
    if (!(CHANNELS as readonly string[]).includes(channel)) {
      throw new BadRequestException(`channel must be one of: ${CHANNELS.join(', ')}`);
    }
    const removed = await this.repository.unsuppress(channel as Channel, decodeURIComponent(recipient));
    if (!removed) throw new NotFoundException();
  }
}
