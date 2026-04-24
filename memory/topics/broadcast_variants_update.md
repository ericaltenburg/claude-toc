# broadcast variants update

## Context
- ALCS stores broadcast variants in a DynamoDB table keyed by (broadcastId, variantType) [2026-04-24]
- Each variant type (POST_LIVE_HLS, POST_LIVE_MP4) contains a list of VariantModel entries keyed by streamId [2026-04-24]
- VariantModel holds publicUrl, s3Url, ivsPublicUrl, ivsMp4PublicUrl, orientation, dimensions, aspectRatio, secondsTrimmed, and caption data [2026-04-24]
- The entry point is UpdateBroadcastVariantsActivity.enact() [2026-04-24]
- A multi-stream weblab controls whether the legacy path (writes directly to BroadcastModel) or modern path (BroadcastVariantsProvider) is used [2026-04-24]
- The modern path delegates to BroadcastVariantsProvider.updateOrCreateBroadcastVariants() which validates the stream, creates/updates the DynamoDB record, syncs HLS URL to the broadcast, and triggers post-live workflows [2026-04-24]
- URL assignment distinguishes IVS vs non-IVS and HLS vs MP4 to choose which URL field to populate [2026-04-24]
- DynamoDB writes use a RetryCaller with 2 retries [2026-04-24]
- Post-live workflows include recap (primary IVS streams only), trimming (via SQS, only one source trimmed per broadcast), and IVS MP4 generation [2026-04-24]
- HLS URL sync to the broadcast record only happens for POST_LIVE_HLS variant type on primary streams [2026-04-24]
- AmazonLiveCatalogService (ALCS) updates broadcast variants via UpdateBroadcastVariantsActivity.enact() [2026-04-24]
- ALCS has two paths for updating variants: legacy (direct broadcast model update) and modern (multi-stream weblab, uses BroadcastVariantsProvider) [2026-04-24]
- BroadcastVariants are stored in a DynamoDB table keyed by (broadcastId, variantType) [2026-04-24]
- Each BroadcastVariants record contains a list of VariantModel entries keyed by streamId [2026-04-24]
- VariantModel stores publicUrl, s3Url, ivsPublicUrl, ivsMp4PublicUrl, orientation, dimensions, aspectRatio, secondsTrimmed, captionUrl, captionLocale [2026-04-24]
- URL assignment differs based on IVS vs non-IVS and HLS vs MP4 variant types [2026-04-24]
- HLS URL is synced back to the broadcast record only for primary streams [2026-04-24]
- Post-live workflows triggered include recap, trimming (via SQS), and IVS MP4 generation [2026-04-24]
- Trimming logic ensures only one recording source (IVS or Wowza) is trimmed per broadcast based on weblabs [2026-04-24]

## Decisions
