import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ChatAgentsModule } from './chat-agents/chat-agents.module';
import { ChatConversationsModule } from './chat-conversations/chat-conversations.module';
import { KnowledgeBasesModule } from './knowledge-bases/knowledge-bases.module';
import { PrismaModule } from './prisma/prisma.module';
import { ToolsModule } from './tools/tools.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    WhatsAppModule,
    WebhooksModule,
    ChatAgentsModule,
    ChatConversationsModule,
    KnowledgeBasesModule,
    ToolsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
