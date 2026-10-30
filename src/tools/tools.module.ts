import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ToolsController } from './tools.controller';
import { ToolsService } from './tools.service';

@Module({
  imports: [AuthModule],
  controllers: [ToolsController],
  providers: [ToolsService],
})
export class ToolsModule {}
