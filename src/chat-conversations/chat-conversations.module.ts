import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { ChatConversationsController } from './chat-conversations.controller';
import { ChatConversationsService } from './chat-conversations.service';

@Module({
  imports: [AuthModule, WhatsAppModule],
  controllers: [ChatConversationsController],
  providers: [ChatConversationsService],
})
export class ChatConversationsModule {}
