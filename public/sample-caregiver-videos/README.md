# Sample Caregiver Videos

The `/caregiver/video` page shows two example videos on the right sidebar to demonstrate what a good 30-second intro looks like. Drop matching files here and they'll automatically appear live — no code change or redeploy needed beyond the next `firebase deploy --only hosting`.

## Expected files

| File                   | Used as                               | Required       |
| ---------------------- | ------------------------------------- | -------------- |
| `sample-1.mp4`         | Sample video #1 (labeled "Laura C.")  | Yes, to show   |
| `sample-1.jpg`         | Poster / thumbnail for sample #1      | Optional       |
| `sample-2.mp4`         | Sample video #2 (labeled "Sarah S.")  | Yes, to show   |
| `sample-2.jpg`         | Poster / thumbnail for sample #2      | Optional       |

If a file is missing, the card falls back to the placeholder state (gray box with video icon) — the layout stays intact.

## Source requirements

- **Duration:** 20–40 seconds (UrbanSitter pattern).
- **Format:** MP4, H.264 video + AAC audio. Safari/iOS requires this — WebM won't play on iOS.
- **Resolution:** 720p or 1080p. Aspect ratio 16:9 recommended.
- **Size:** Keep under ~10 MB each if possible — these load eagerly for every visitor to `/caregiver/video`.
- **Rights:** Make sure you have the right to host and display the footage. Stock-video licenses often prohibit use as "sample content" without modification — read the license. Best option: record two volunteer caregivers with a signed release.

## Updating the labels

The speaker names and durations are hard-coded in `components/caregiver/CaregiverIntroVideo.tsx` under the `SAMPLE_VIDEOS` array. Edit that file to change "Laura C. · ~28 seconds" etc.

## Why poster images?

The `.jpg` files are shown before the video plays, so the card doesn't render as a black box. Pick a well-lit frame from the video itself; 1280×720 is fine.

## Testing locally

After adding files, run `npm run dev` and visit `http://localhost:5173/caregiver/video`. You should see playable videos in the right sidebar. The card auto-detects the file via a `HEAD` request — if it 404s, the placeholder shows.
