import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

// Service role client - bypasses RLS policies, should only be used in server-side code
const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const BUCKET = 'drive';

// Build a consistent storage key for every file
// tenanats/{ownerId}/{fileId}/{fileName}
export function buildStorageKey(
    ownerId: string,
    fileId: string,
    fileName: string
): string {
    const ext = fileName.split('.').pop() ?? '';
    const slug = fileName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric characters with hyphens
        .replace(/-+/g, '-') // Replace multiple hyphens with a single hyphen
    return `tenants/${ownerId}/${fileId}/${slug}.${ext}`;
}

// Generate a presigned URL the browser uploads TO diectly
export async function createPresignedUploadUrl(
    storageKey: string,
    expiresInSeconds: number = 900 // 15 minutes
): Promise<string> {
    const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUploadUrl(storageKey);
    if(error || !data) {
        console.error('Error creating presigned upload URL:', error);
        throw new Error('Failed to create presigned upload URL');
    }
    return data.signedUrl;
}

// Generate a presigned URL the browser can download directly
export async function createPresignedDownloadUrl(
  storageKey: string,
  expiresInSeconds: number = 300
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storageKey, expiresInSeconds);  // ← fixed
  if (error || !data) {
    console.error('Error creating presigned download URL:', error);
    throw new Error('Failed to create presigned download URL');
  }
  return data.signedUrl;
}

// Delete an object from storage (used during cleanup)
export async function deleteObject(storageKey: string): Promise<void> {
    const { error } = await supabase.storage
        .from(BUCKET)
        .remove([storageKey]);
    if(error) {
        console.error('Error deleting object:', error.message);
        throw new Error('Failed to delete object');
    }
}