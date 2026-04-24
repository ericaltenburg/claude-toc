# alcs broadcast variants

## Context
- ALCS repo is in code.amazon.com [2026-04-24]
- Entry point is UpdateBroadcastVariantsActivity.enact() which receives broadcastId, variantType, streamId, url, and isIvsVariant flag [2026-04-24]
- BroadcastVariants are stored in a DynamoDB table with PK=broadcastId, SK=variantType, containing a list of VariantModel items [2026-04-24]
- There is a legacy path (direct broadcast.hlsUrl/mp4Model update) and a modern path (BroadcastVariantsProvider) controlled by canRenderMultiStreamExperience weblab [2026-04-24]
- BroadcastVariantsProvider.updateOrCreateBroadcastVariants() validates stream ownership, creates or updates variants in DynamoDB, syncs HLS URL to broadcast record for backward compat, and triggers post-live workflows [2026-04-24]
- System supports both Wowza (publicUrl/s3Url) and IVS (ivsPublicUrl/ivsMp4PublicUrl) recording paths with weblabs controlling migration [2026-04-24]
- POST_LIVE_HLS variant on primary stream gets synced back to broadcast.hlsUrl for backward compatibility [2026-04-24]
- Post-live workflows triggered include recap generation, trimming via SQS, and IVS MP4 generation via ALVTS [2026-04-24]
- Only one variant type (IVS or Wowza) is trimmed per broadcast to avoid conflicts, controlled by isIVSRecordingUsed and isTrimmingOnIVSEnabled weblabs [2026-04-24]
- DynamoDB writes use 2 retries on error [2026-04-24]
- ALCS UpdateBroadcastVariantsActivity is the entry point for broadcast variant updates, receiving broadcastId, variantType, streamId, url, and isIvsVariant [2026-04-24]
- BroadcastVariantsProvider validates the stream, creates/updates variants in DynamoDB, syncs HLS URL to the broadcast record, and triggers post-live workflows [2026-04-24]
- IVS variants use ivsPublicUrl/ivsMp4PublicUrl fields while Wowza variants use publicUrl/s3Url fields [2026-04-24]
- POST_LIVE_HLS variants on the primary stream sync back to broadcast.hlsUrl for backward compatibility [2026-04-24]
- Post-live workflows triggered include recap, trimming (via SQS), and IVS MP4 generation (via ALVTS) [2026-04-24]
- DynamoDB writes use 2 retries on errors [2026-04-24]
- BroadcastVariantsProvider.updateOrCreateBroadcastVariants validates the stream, creates/updates variants in DynamoDB, syncs HLS URL to the broadcast record, and triggers post-live workflows [2026-04-24]

## Decisions
