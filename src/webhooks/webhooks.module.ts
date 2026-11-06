import { Module } from '@nestjs/common';
import { AgentFilesModule } from '../agent-files/agent-files.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [AgentFilesModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
