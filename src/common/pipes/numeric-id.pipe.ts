import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { BadRequestError } from '../errors/tiktok-errors';

const NUMERIC_ID = /^\d{5,25}$/;

@Injectable()
export class NumericIdPipe implements PipeTransform<string, string> {
  transform(value: string, { data }: ArgumentMetadata): string {
    const id = value?.trim() ?? '';
    if (!NUMERIC_ID.test(id)) {
      throw new BadRequestError(`${data ?? 'id'} must be a numeric TikTok id`, { value });
    }
    return id;
  }
}
