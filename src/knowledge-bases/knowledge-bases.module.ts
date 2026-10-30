import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IndexerService } from './indexer.service';
import { KnowledgeBasesController } from './knowledge-bases.controller';
import { KnowledgeBasesService } from './knowledge-bases.service';

@Module({
  imports: [AuthModule],
  controllers: [KnowledgeBasesController],
  providers: [KnowledgeBasesService, IndexerService],
})
export class KnowledgeBasesModule {}
