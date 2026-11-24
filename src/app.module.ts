import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentFilesModule } from './agent-files/agent-files.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ChatAgentsModule } from './chat-agents/chat-agents.module';
import { ChatConversationsModule } from './chat-conversations/chat-conversations.module';
import { ChatMemoryModule } from './chat-memory/chat-memory.module';
import { FollowUpsModule } from './follow-ups/follow-ups.module';
import { KnowledgeBasesModule } from './knowledge-bases/knowledge-bases.module';
import { OrdersModule } from './orders/orders.module';
import { PrismaModule } from './prisma/prisma.module';
import { SiteVisitsModule } from './site-visits/site-visits.module';
import { ToolsModule } from './tools/tools.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    WhatsAppModule,
    WebhooksModule,
    ChatMemoryModule,
    ChatAgentsModule,
    ChatConversationsModule,
    FollowUpsModule,
    KnowledgeBasesModule,
    ToolsModule,
    OrdersModule,
    AgentFilesModule,
    SiteVisitsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
