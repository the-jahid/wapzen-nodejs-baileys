import { Module } from '@nestjs/common';
import { FreeToolsController } from './free-tools.controller';
import { FreeToolsService } from './free-tools.service';

@Module({
  controllers: [FreeToolsController],
  providers: [FreeToolsService],
})
export class FreeToolsModule {}
