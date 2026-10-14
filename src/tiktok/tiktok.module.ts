import { Module } from '@nestjs/common';
import { SessionModule } from '../session/session.module';
import { TiktokClient } from './tiktok.client';
import { TiktokService } from './tiktok.service';
import { InternalController, TiktokController } from './tiktok.controller';

@Module({
  imports: [SessionModule],
  controllers: [TiktokController, InternalController],
  providers: [TiktokClient, TiktokService],
  exports: [TiktokService, TiktokClient],
})
export class TiktokModule {}
