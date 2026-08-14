---
dusk: v1alpha1
namespace: stout
kind: repository
name: scrypted-otel
title: Scrypted OTel Collector
attributes:
  language: typescript
  platform: scrypted
  public: true
---

A Scrypted plugin that turns camera object detections into OpenTelemetry metrics.
It walks the Scrypted device tree at startup, subscribes to every device that is a Camera or advertises `ObjectDetector` or `MotionSensor`, and exports a single counter over OTLP/HTTP to a collector URL configured in the plugin's own Settings page.

The counter is `scrypted.events.total`, incremented once per detection class per event, labelled with the device id, name and type, the detection class, the score and the `detectionId`.
Note that the score is a label rather than a measurement, so "only alert above 0.9" is a query-time filter on that label, not something the plugin computes.

All of it is `src/main.ts`, one `ScryptedDeviceBase` implementing `Settings`, built with `scrypted-webpack` from the `@scrypted/sdk` toolchain.
Settings are read from and written to Scrypted's per-plugin `storage`, and changing the endpoint, the enable toggle or the export interval tears down the meter provider and the device listeners and rebuilds them; the class filter and the cooldown are read live on each event instead.
`npm run build` compiles it, and `F5` in VS Code deploys and attaches a debugger to a running server.

## Gotchas

**Three separate things throttle the metrics, which is why counts look lower than the camera activity.** The plugin ignores any detection event without a `detectionId`, because Scrypted NVR only sets that on detections it has decided to retain, and that alone is what keeps this from emitting per video frame. On top of it there is a per-device cooldown, ten seconds by default, and within one event only the first detection of each class emits. Before concluding that detections are being missed, check all three.

**Filter `motion` at minimum.** Motion fires constantly and swamps everything useful. The filter is a comma-separated substring match on the class name, so `plate` also removes `license_plate`.

**The endpoint has to be the full metrics path.** Something like `.../v1/metrics`, because the exporter posts to exactly what you give it and appends nothing. A collector host on its own silently fails to export.

**There is no authentication.** The exporter sends no headers and the plugin offers nowhere to put a token, so the collector has to be protected at the network layer. The only validation performed on the endpoint is that it parses as a URL with an `http` or `https` scheme.

**It is not installable from the Scrypted plugin repository, despite what the README implies.** The `package.json` name is `@scrypted/otel-collector`, a scope that belongs to the upstream project, and nothing is published at that name. Getting it onto a server today means building locally and deploying straight to it. Publishing it properly means renaming the package to a scope that can actually be published first.
