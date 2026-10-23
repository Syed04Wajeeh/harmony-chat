import { createHash, randomUUID } from 'node:crypto';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream';
import { fileTypeFromBuffer } from 'file-type';
import { imageSize } from 'image-size';
import type { Kysely } from 'kysely';
import type { Attachment, DirectoryUser } from '@harmony/shared';
import type { Database } from '../../db/schema.js';
import { AppError } from '../../errors.js';
import { attachmentUrl } from '../../messages/reader.js';
import { sanitizeFilename } from '../../uploads/filename.js';
import type { Storage } from '../../uploads/storage.js';

/** Enough bytes for every signature file-type checks and for raster image headers. */
const SNIFF_BYTES = 64 * 1024;
const FALLBACK_TYPE = 'application/octet-stream';
const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Passes bytes through while hashing, counting and keeping the head of the stream. */
class UploadTap extends Transform {
  readonly hash = createHash('sha256');
  size = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }
  private head: Buffer[] = [];
  private headBytes = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.hash.update(chunk);
    this.size += chunk.length;
    if (this.size > this.maxBytes) {
      done(Object.assign(new Error('file too large'), { code: 'FST_REQ_FILE_TOO_LARGE' }));
      return;
    }
    if (this.headBytes < SNIFF_BYTES) {
      this.head.push(chunk);
      this.headBytes += chunk.length;
    }
    done(null, chunk);
  }

  get headBuffer(): Buffer {
    return Buffer.concat(this.head).subarray(0, SNIFF_BYTES);
  }
}

export interface StoredFile {
  row: {
    id: string;
    filename: string;
    content_type: string;
    size_bytes: string;
    storage_key: string;
  };
  stream: Readable;
}

export class UploadService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly storage: Storage,
  ) {}

  async store(
    uploader: DirectoryUser,
    rawFilename: string,
    source: Readable & { truncated?: boolean },
    maxBytes: number,
  ): Promise<Attachment> {
    const key = randomUUID();
    const tap = new UploadTap(maxBytes);
    // pipeline (unlike .pipe) forwards a size-limit error from `source` into `tap`, so the
    // write to storage fails and the partial file is removed.
    const tapped = pipeline(source, tap, () => undefined);
    try {
      await this.storage.put(key, tapped);
    } catch (error) {
      await this.storage.delete(key).catch(() => undefined);
      if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new AppError(413, 'file_too_large', 'File is too large');
      }
      throw error;
    }
    if (source.truncated === true) {
      await this.storage.delete(key);
      throw new AppError(413, 'file_too_large', 'File is too large');
    }
    if (tap.size === 0) {
      await this.storage.delete(key);
      throw new AppError(400, 'empty_file', 'File is empty');
    }

    // The client-declared type is ignored: the real type comes from the file's own bytes.
    const head = tap.headBuffer;
    const detected = await fileTypeFromBuffer(head);
    const contentType = detected?.mime ?? FALLBACK_TYPE;
    const dimensions = RASTER_TYPES.has(contentType) ? measure(head) : null;

    try {
      const row = await this.db
        .insertInto('attachments')
        .values({
          uploader_id: uploader.id,
          message_id: null,
          filename: sanitizeFilename(rawFilename),
          content_type: contentType,
          size_bytes: tap.size,
          sha256: tap.hash.digest('hex'),
          storage_key: key,
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return {
        id: row.id,
        filename: row.filename,
        contentType: row.content_type,
        sizeBytes: Number(row.size_bytes),
        width: row.width,
        height: row.height,
        url: attachmentUrl(row.id, row.filename),
      };
    } catch (error) {
      await this.storage.delete(key).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Guild icons and banners are shown to every signed-in user, including people previewing an invite;
   * webhook avatars appear next to messages members can read, so they are public the same way.
   */
  private async isGuildImage(attachmentId: string): Promise<boolean> {
    const guild = await this.db
      .selectFrom('guilds')
      .select('id')
      .where((eb) =>
        eb.or([
          eb('icon_attachment_id', '=', attachmentId),
          eb('banner_attachment_id', '=', attachmentId),
        ]),
      )
      .executeTakeFirst();
    if (guild) return true;
    const webhook = await this.db
      .selectFrom('webhooks')
      .select('id')
      .where('avatar_attachment_id', '=', attachmentId)
      .executeTakeFirst();
    if (webhook) return true;
    const profile = await this.db
      .selectFrom('user_profiles')
      .select('user_id')
      .where((eb) =>
        eb.or([
          eb('avatar_attachment_id', '=', attachmentId),
          eb('banner_attachment_id', '=', attachmentId),
        ]),
      )
      .executeTakeFirst();
    if (profile) return true;
    const emoji = await this.db
      .selectFrom('guild_emoji')
      .select('id')
      .where('attachment_id', '=', attachmentId)
      .executeTakeFirst();
    return emoji !== undefined;
  }

  /** Opens the image of a custom emoji. */
  async openEmoji(user: DirectoryUser, emojiId: string): Promise<StoredFile> {
    const emoji = await this.db
      .selectFrom('guild_emoji')
      .select('attachment_id')
      .where('id', '=', emojiId)
      .executeTakeFirst();
    if (!emoji) throw notFound();
    return this.open(user, emoji.attachment_id);
  }

  /** Opens an attachment for a user who may see it: channel members, or the uploader until attached. */
  async open(user: DirectoryUser, id: string): Promise<StoredFile> {
    const row = await this.db
      .selectFrom('attachments')
      .leftJoin('messages', 'messages.id', 'attachments.message_id')
      .select([
        'attachments.id',
        'attachments.filename',
        'attachments.content_type',
        'attachments.size_bytes',
        'attachments.storage_key',
        'attachments.uploader_id',
        'attachments.message_id',
        'messages.channel_id',
        'messages.deleted_at',
      ])
      .where('attachments.id', '=', id)
      .executeTakeFirst();
    if (!row || row.deleted_at) throw notFound();

    if (row.message_id && row.channel_id) {
      const member = await this.db
        .selectFrom('channel_members')
        .select('user_id')
        .where('channel_id', '=', row.channel_id)
        .where('user_id', '=', user.id)
        .executeTakeFirst();
      if (!member) throw new AppError(403, 'forbidden', 'You are not a member of this channel');
    } else if (row.uploader_id !== user.id && !(await this.isGuildImage(id))) {
      throw new AppError(403, 'forbidden', 'This upload is not attached to a message you can see');
    }

    try {
      return { row, stream: await this.storage.get(row.storage_key) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound();
      throw error;
    }
  }
}

function measure(head: Buffer): { width: number; height: number } | null {
  try {
    const { width, height } = imageSize(head);
    return width && height ? { width, height } : null;
  } catch {
    return null;
  }
}

const notFound = () => new AppError(404, 'attachment_not_found', 'Attachment not found');
