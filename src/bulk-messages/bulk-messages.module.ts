import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import {
  BulkMessagesController,
  MessageTemplatesController,
} from './bulk-messages.controller';
import { BulkMessagesService } from './bulk-messages.service';
import { BulkSenderService } from './bulk-sender.service';
import { MessageTemplatesService } from './message-templates.service';

@Module({
  imports: [AuthModule, WhatsAppModule],
  controllers: [BulkMessagesController, MessageTemplatesController],
  providers: [BulkMessagesService, MessageTemplatesService, BulkSenderService],
})
export class BulkMessagesModule {}
