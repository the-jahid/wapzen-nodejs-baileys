import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KnowledgeBasesModule } from '../knowledge-bases/knowledge-bases.module';
import { OrdersModule } from '../orders/orders.module';
import { ChatResponderService } from './chat-responder.service';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';

@Module({
  imports: [AuthModule, KnowledgeBasesModule, OrdersModule],
  controllers: [WhatsAppController],
  providers: [WhatsAppService, ChatResponderService],
  exports: [WhatsAppService, ChatResponderService],
})
export class WhatsAppModule {}
