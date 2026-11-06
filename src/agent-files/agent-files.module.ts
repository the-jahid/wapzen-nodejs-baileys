import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AgentFilesController } from './agent-files.controller';
import { AgentFilesService } from './agent-files.service';

@Module({
  imports: [AuthModule],
  controllers: [AgentFilesController],
  providers: [AgentFilesService],
  exports: [AgentFilesService],
})
export class AgentFilesModule {}
