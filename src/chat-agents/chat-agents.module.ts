import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatAgentsController } from './chat-agents.controller';
import { ChatAgentsService } from './chat-agents.service';

@Module({
  imports: [AuthModule],
  controllers: [ChatAgentsController],
  providers: [ChatAgentsService],
})
export class ChatAgentsModule {}
