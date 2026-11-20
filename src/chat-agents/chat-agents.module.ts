import { Module } from '@nestjs/common';
import { AgentFilesModule } from '../agent-files/agent-files.module';
import { AuthModule } from '../auth/auth.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { ChatAgentsController } from './chat-agents.controller';
import { ChatAgentsService } from './chat-agents.service';

@Module({
  imports: [AuthModule, AgentFilesModule, WhatsAppModule],
  controllers: [ChatAgentsController],
  providers: [ChatAgentsService],
})
export class ChatAgentsModule {}
