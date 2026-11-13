import { createHash } from 'node:crypto';
import type { getServerSupabaseClients } from './supabase.js';

export interface IntentRow {
  id: string;
  owner_id: string;
  source: 'portal' | 'kiosk' | 'guard_offline';
  kind: 'photo' | 'id' | 'vehicle_photo';
  bucket_id: string;
  object_path: string;
  content_type: string;
  max_bytes: number;
  status: string;
  expires_at: string;
}

export interface InspectedUpload {
  bytes: number;
  sha256: string;
}

export function validMagic(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === 'image/png') return bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index]);
  if (contentType === 'image/webp') {
    return new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF'
      && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
  }
  return false;
}

export async function inspectUploadIntent(
  admin: ReturnType<typeof getServerSupabaseClients>['admin'],
  id: string,
  actorId: string,
  source: 'portal' | 'kiosk' | 'guard_offline',
  kind: 'photo' | 'id' | 'vehicle_photo'
): Promise<InspectedUpload> {
  const { data, error } = await admin.from('upload_intents').select('*').eq('id', id).maybeSingle<IntentRow>();
  if (error) throw error;
  if (!data) {
    console.warn(`[UPLOAD-INSPECT] Upload intent (${kind}) rejected: intent_not_found`);
    throw new Error('invalid_upload_intent');
  }
  if (data.owner_id !== actorId) {
    console.warn(`[UPLOAD-INSPECT] Upload intent (${kind}) rejected: intent_owner_mismatch`);
    throw new Error('invalid_upload_intent');
  }
  if (data.source !== source) {
    console.warn(`[UPLOAD-INSPECT] Upload intent (${kind}) rejected: intent_source_mismatch (actual=${data.source}, expected=${source})`);
    throw new Error('invalid_upload_intent');
  }
  if (data.kind !== kind) {
    console.warn(`[UPLOAD-INSPECT] Upload intent (${kind}) rejected: intent_kind_mismatch (actual=${data.kind}, expected=${kind})`);
    throw new Error('invalid_upload_intent');
  }
  if (data.status !== 'pending') {
    console.warn(`[UPLOAD-INSPECT] Upload intent (${kind}) rejected: intent_status_not_pending (status=${data.status})`);
    throw new Error('invalid_upload_intent');
  }
  if (new Date(data.expires_at).getTime() <= Date.now()) {
    console.warn(`[UPLOAD-INSPECT] Upload intent (${kind}) rejected: intent_expired (expiredAt=${data.expires_at})`);
    throw new Error('invalid_upload_intent');
  }

  const downloaded = await admin.storage.from(data.bucket_id).download(data.object_path);
  if (downloaded.error) throw new Error('missing_uploaded_object');

  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  if (bytes.length < 12 || bytes.length > data.max_bytes || !validMagic(bytes, data.content_type)) {
    throw new Error('invalid_uploaded_content');
  }

  return {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
