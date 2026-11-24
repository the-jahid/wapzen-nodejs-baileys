import { Global, Module } from '@nestjs/common';
import { ChatMemoryService } from './chat-memory.service';

@Global()
@Module({
  providers: [ChatMemoryService],
  exports: [ChatMemoryService],
})
export class ChatMemoryModule {}
