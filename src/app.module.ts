import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { SessionModule } from './session/session.module';
import { TiktokModule } from './tiktok/tiktok.module';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';

@Module({
  imports: [CommonModule, SessionModule, TiktokModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
