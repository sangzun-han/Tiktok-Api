import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

const toBool = ({ value }: { value: unknown }): boolean => {
  if (typeof value === 'boolean') return value;
  const v = String(value).toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
};

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CountQueryDto {
  @IsOptional()
  @Type(() => Number)
  @Max(50)
  @Min(1)
  @IsInt()
  count?: number;
}

export class PageQueryDto extends CountQueryDto {
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Matches(/^-?\d+$/, { message: 'cursor must be a numeric cursor from a previous response' })
  cursor?: string;
}

export class UserDetailQueryDto {
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Matches(/^[A-Za-z0-9._]{1,24}$/, {
    message: 'uniqueId must be a TikTok handle without the leading "@"',
  })
  uniqueId?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  secUid?: string;
}

export class UserPageQueryDto extends PageQueryDto {
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  declare secUid: string;
}

export class SearchQueryDto extends CountQueryDto {
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  declare keyword: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @Matches(/^\d+$/, { message: 'offset must be the numeric cursor from a previous response' })
  offset?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @Matches(/^[A-Za-z0-9]{1,64}$/, { message: 'searchId must be log_pb.impr_id from the first page' })
  searchId?: string;
}

export class RawRequestDto {
  @IsString()
  @Transform(trim)
  @Matches(/^\/[^/]/, {
    message: 'path must be an origin-relative path beginning with a single "/"',
  })
  declare path: string;

  @IsOptional()
  @IsObject()
  query?: Record<string, string | number | boolean>;

  @IsOptional()
  @IsString()
  referer?: string;

  @IsOptional()
  @IsIn(['GET', 'POST'])
  method?: 'GET' | 'POST';

  @IsOptional()
  @IsString()
  body?: string;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  sign?: boolean;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  bare?: boolean;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  allowEmpty?: boolean;
}
