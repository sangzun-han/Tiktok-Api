export interface AppContext {
  aid?: number;
  region?: string;
  wid?: string;
  odinId?: string;
  nonce?: string;
  webIdCreatedTime?: string;
  csrfToken?: string;
  userAgent?: string;
  botType?: string;
  abTestVersions?: string;
  raw: Record<string, unknown>;
}

const REHYDRATION_RE =
  /<script[^>]+id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i;

export function parseAppContext(html: string): AppContext | undefined {
  const match = REHYDRATION_RE.exec(html);
  if (!match) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return undefined;
  }

  const scope = (parsed as { __DEFAULT_SCOPE__?: Record<string, unknown> }).__DEFAULT_SCOPE__;
  const context = scope?.['webapp.app-context'] as Record<string, unknown> | undefined;
  if (!context || typeof context !== 'object') return undefined;

  const num = (v: unknown): number | undefined =>
    typeof v === 'number' ? v : typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v : undefined;

  const aid = num(context['appId']) ?? num(context['aid']);

  return {
    aid,
    region: str(context['region']),
    wid: str(context['wid']),
    odinId: str(context['odinId']),
    nonce: str(context['nonce']),
    webIdCreatedTime: str(context['webIdCreatedTime']),
    csrfToken: str(context['csrfToken']),
    userAgent: str(context['userAgent']),
    botType: str(context['botType']),
    abTestVersions:
      str((context['abTestVersion'] as Record<string, unknown> | undefined)?.['versionName']) ?? undefined,
    raw: context,
  };
}
