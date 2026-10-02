-- ============================================================
--  0030 · Remove the settings of AI providers the studio no longer uses
--
--  Gemini (boards and renderings), Grok / xAI (renderings and video) and
--  Cloudflare Workers AI (free photos) were taken out of Settings. The app no
--  longer reads any of these, so the encrypted keys and model choices they left
--  in organizations.settings are dead weight — and an API key at rest that
--  nothing uses is a liability for no benefit.
--
--  Only these keys are touched; every other setting (Claude, OpenAI, Slack,
--  ingest cadence, cron claims) is left exactly as it is. If the studio had
--  picked one of the removed providers as its picture engine, that choice is
--  cleared too, so the engine falls back to the default (OpenAI).
--
--  Safe to re-run.
-- ============================================================

update organizations
set settings = (
  coalesce(settings, '{}'::jsonb) - array[
    'xai_api_key_encrypted', 'xai_image_model', 'xai_video_model',
    'image_api_key_encrypted', 'image_model',
    'cloudflare_account_id', 'cloudflare_api_token_encrypted', 'cloudflare_model', 'cloudflare_steps'
  ]
) - (
  case
    when settings->>'picture_engine' in ('gemini', 'cloudflare', 'grok') then array['picture_engine']
    else array[]::text[]
  end
)
where settings ?| array[
  'xai_api_key_encrypted', 'xai_image_model', 'xai_video_model',
  'image_api_key_encrypted', 'image_model',
  'cloudflare_account_id', 'cloudflare_api_token_encrypted', 'cloudflare_model', 'cloudflare_steps'
] or settings->>'picture_engine' in ('gemini', 'cloudflare', 'grok');
