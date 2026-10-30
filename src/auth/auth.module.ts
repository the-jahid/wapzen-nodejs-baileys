import { Module } from '@nestjs/common';
import { ClerkAuthGuard } from './auth.guard';

@Module({
  providers: [ClerkAuthGuard],
  exports: [ClerkAuthGuard],
})
export class AuthModule {}
