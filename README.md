# Scrypted OpenTelemetry Object Detection Plugin

Send Scrypted camera object detection events to an OpenTelemetry Collector as metrics for monitoring, alerting, and analysis.

## Overview

This plugin monitors camera object detection events (person, vehicle, package, etc.) and exports them as OpenTelemetry metrics. It integrates with Scrypted's NVR object detection system to provide intelligent deduplication and filtering, ensuring you only receive meaningful detection metrics without being overwhelmed by frame-by-frame noise.

## Features

- **Smart Detection Tracking**: Only sends metrics for actual detection sessions, not every video frame
- **Multi-layer Deduplication**:
  - Uses Scrypted's `detectionId` to filter frame-by-frame noise
  - Device cooldown prevents metric flooding during rapid successive detections
  - Per-event className deduplication avoids duplicate metrics for the same object class
- **Flexible Filtering**: Configure which detection classes to skip (e.g., filter out noisy "motion" events)
- **Camera-Specific**: Automatically discovers and subscribes to cameras and object detectors
- **Diagnostic Logging**: Built-in OTEL collector response logging for troubleshooting
- **Security**: URL validation to prevent SSRF attacks
- **Configurable**: All settings managed through Scrypted UI

## How It Works

### Detection Flow

1. **Device Discovery**: Plugin discovers cameras and devices with ObjectDetector interface
2. **Event Subscription**: Subscribes to `ObjectDetector` events for each device
3. **Detection Filtering**: Only processes events with a `detectionId` (flagged by Scrypted NVR for retention)
4. **Cooldown Check**: Skips events if device is in cooldown period
5. **Class Filtering**: Applies user-configured detection class filters
6. **Deduplication**: Emits only one metric per unique className per event
7. **Export**: Periodically sends metrics to OTEL collector

### Multi-Layer Deduplication

The plugin uses three layers of deduplication to ensure clean, meaningful metrics:

**Layer 1: Scrypted's detectionId**
- Scrypted NVR Object Detection analyzes every video frame but only flags significant detections for retention
- Only detections with a `detectionId` are processed, filtering out frame-by-frame noise
- This is automatic and handled by Scrypted itself

**Layer 2: Device Cooldown**
- Configurable minimum time between metrics per device (default: 10 seconds)
- Prevents flooding if multiple detections occur in rapid succession
- Example: If a person walks by and triggers 3 detections in 5 seconds, only the first generates a metric

**Layer 3: Per-Event ClassName Deduplication**
- Within a single detection event, only emit one metric per unique className
- Example: If a single event contains 3 "vehicle" detections (same car in different positions), only one "vehicle" metric is emitted

## Metrics Emitted

### `scrypted.events.total` (Counter)

Counts object detection events by device and detection class.

**Labels:**
- `scrypted.device.id`: Unique device identifier
- `scrypted.device.name`: Human-readable device name (e.g., "Front Door Camera")
- `scrypted.device.type`: Device type (e.g., "Camera")
- `scrypted.detection.class`: Object class detected (e.g., "person", "vehicle", "package")
- `scrypted.detection.score`: Detection confidence score (0.00-1.00)
- `scrypted.detection.id`: Scrypted detection session identifier

**Example Metrics:**
```
scrypted_events_total{device_name="Front Door Camera",detection_class="person",detection_score="0.92"} 1
scrypted_events_total{device_name="Driveway Camera",detection_class="vehicle",detection_score="0.88"} 1
scrypted_events_total{device_name="Backyard Camera",detection_class="package",detection_score="0.95"} 1
```

## Setup

### Prerequisites

- Scrypted server with cameras configured
- Scrypted NVR Object Detection plugin enabled and configured
- OpenTelemetry Collector running and accessible

### 1. Configure OTEL Collector

Ensure your OpenTelemetry Collector is configured to receive metrics via HTTP OTLP.

**Example collector config (`otel-collector-config.yaml`):**

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

exporters:
  logging:
    loglevel: info
  prometheus:
    endpoint: "0.0.0.0:8889"
  # Add other exporters as needed

service:
  pipelines:
    metrics:
      receivers: [otlp]
      exporters: [logging, prometheus]
```

**Run with Docker:**

```bash
docker run -p 4318:4318 -p 8889:8889 \
  -v $(pwd)/otel-collector-config.yaml:/etc/otel-collector-config.yaml \
  otel/opentelemetry-collector:latest \
  --config=/etc/otel-collector-config.yaml
```

### 2. Install Plugin

#### Development

1. Clone this repository
2. Install dependencies: `npm install`
3. Build: `npm run build`
4. Deploy to Scrypted:
   - Edit `.vscode/settings.json` to point to your Scrypted server
   - Press F5 in VS Code to deploy

#### Production

_Plugin will be available in Scrypted plugin repository after release._

### 3. Configure Plugin

Navigate to the plugin in Scrypted Management Console and configure:

#### Settings

**Enable OTEL Collector** (toggle)
- Enable/disable event forwarding
- Default: `false`

**OTEL Collector Endpoint** (string)
- HTTP endpoint for your OTEL collector
- Must include full path
- Example: `http://localhost:4318/v1/metrics`
- Required: Yes

**Detection Class Filter** (string)
- Comma-separated list of detection classes to **SKIP**
- Case-insensitive partial matching
- Example: `motion` (filters out motion events but keeps person, vehicle, etc.)
- Example: `motion,clip` (filters out multiple classes)
- Leave empty to forward all detection classes
- **Recommendation**: Filter `motion` at minimum (very noisy)
- Default: empty

**Export Interval** (milliseconds)
- How often to batch and send metrics to the collector
- Range: 1000-60000ms
- Default: `10000` (10 seconds)

**Device Cooldown** (seconds)
- Minimum time between metrics per device
- Prevents flooding during rapid successive detections
- Range: 1-300 seconds
- Default: `10` seconds

## Configuration Examples

### Minimal Setup (Recommended)

```
Enable: ✓
Endpoint: http://localhost:4318/v1/metrics
Detection Filter: motion
Export Interval: 10000
Device Cooldown: 10
```

This filters out noisy motion events while keeping person, vehicle, and other meaningful detections.

### High-Traffic Environment

```
Enable: ✓
Endpoint: http://your-collector:4318/v1/metrics
Detection Filter: motion,clip
Export Interval: 5000
Device Cooldown: 30
```

Increase cooldown to 30 seconds and filter more aggressively to reduce metric volume.

### Capture Everything (Not Recommended)

```
Enable: ✓
Endpoint: http://localhost:4318/v1/metrics
Detection Filter: (empty)
Export Interval: 10000
Device Cooldown: 5
```

This will generate a very high volume of metrics. Only use for debugging or low-activity cameras.

## Example Queries

### Prometheus/PromQL

```promql
# Detection rate per camera (last 5 minutes)
rate(scrypted_events_total[5m])

# Total detections by class
sum by (scrypted_detection_class) (scrypted_events_total)

# Person detections at front door (last hour)
increase(scrypted_events_total{
  scrypted_device_name="Front Door Camera",
  scrypted_detection_class="person"
}[1h])

# High-confidence detections only (score > 0.90)
scrypted_events_total{scrypted_detection_score=~"0.9.*|1.00"}

# Vehicle detections across all cameras
sum(scrypted_events_total{scrypted_detection_class="vehicle"})
```

### Grafana Dashboard Ideas

- **Detection Rate Timeline**: Graph showing detections per camera over time
- **Detection Class Distribution**: Pie chart of person vs vehicle vs package detections
- **Camera Activity Heatmap**: Time-of-day heatmap showing when each camera is most active
- **Top Detection Cameras**: Table of cameras sorted by detection count
- **Alert Panel**: Highlight unusual detection patterns (e.g., package detection after 10pm)

## Event Log Examples

### Normal Detection Event

```
=== DETECTION EVENT (with detectionId) ===
Device: Front Door Camera (abc123)
Detection ID: 1d89-5
Timestamp: 1766080487632
Detections: 2
  - person (score: 0.92)
    Metric emitted for person
  - motion (score: 1.00)
    Filtered out by settings: motion
=========================================
```

### Cooldown Skip

```
[COOLDOWN] Skipping event from Front Door Camera - 7s remaining
```

### Duplicate Class Skip

```
=== DETECTION EVENT (with detectionId) ===
Device: Driveway Camera (def456)
Detection ID: 2a34-8
Timestamp: 1766080490123
Detections: 3
  - vehicle (score: 0.83)
    Metric emitted for vehicle
  - vehicle (score: 0.89)
    Skipped duplicate className: vehicle
  - vehicle (score: 0.94)
    Skipped duplicate className: vehicle
=========================================
```

### OTEL Collector Response

```
[OTEL INFO] Sending metrics to http://localhost:4318/v1/metrics
[OTEL INFO] Export of metrics succeeded
```

## Troubleshooting

### No metrics appearing

**Check plugin logs in Scrypted Console:**
1. Verify plugin is enabled
2. Look for `Subscribed to X devices` message
3. Check for `DETECTION EVENT` logs when motion occurs
4. Verify `[OTEL INFO] Export of metrics succeeded` appears

**Common issues:**
- Endpoint URL incorrect (must include `/v1/metrics`)
- OTEL collector not running or not accessible
- No cameras have ObjectDetector interface enabled
- All detection classes are filtered out
- Device is in cooldown period

### Too many/few metrics

**Too many metrics:**
- Add detection classes to filter (especially `motion`)
- Increase device cooldown (try 30-60 seconds)
- Increase export interval to 30000ms

**Too few metrics:**
- Check detection class filter isn't too aggressive
- Reduce device cooldown to 5 seconds
- Verify Scrypted NVR Object Detection is running
- Check camera has recent detections in Scrypted UI

### OTEL collector errors

```
[OTEL ERROR] Failed to export metrics
[OTEL ERROR] Error details: <message>
```

**Solutions:**
- Verify collector endpoint is correct
- Check collector logs for details
- Ensure collector is configured to accept HTTP OTLP on port 4318
- Check network connectivity and firewall rules

### High confidence detections not appearing

The plugin exports all detections regardless of score. Use PromQL filtering in your dashboards/alerts:

```promql
scrypted_events_total{scrypted_detection_score=~"0.9.*|1.00"}
```

## Security Considerations

- **Protocol validation**: Only `http://` and `https://` endpoints allowed
- **URL validation**: Prevents SSRF attacks
- **Network security**: Protect your OTEL collector with firewall rules or VPN
- **No authentication**: Plugin doesn't support auth headers (use network-level security)
- **Sensitive data**: Detection events include device names and locations in labels

## Development

### Build

```bash
npm install
npm run build
```

### Debug

1. Set breakpoints in VS Code
2. Press F5 to deploy and attach debugger
3. Plugin hot-reloads on changes

### Project Structure

```
src/
  main.ts          # Plugin implementation
package.json       # Dependencies and metadata
README.md          # This file
```

## Performance Notes

- **Memory**: Plugin tracks device cooldown timestamps (minimal overhead)
- **CPU**: Event processing is lightweight (~1ms per detection)
- **Network**: Metrics exported in batches every 10 seconds by default
- **Storage**: No persistent storage required

## References

- [Scrypted ObjectDetector Interface](https://developer.scrypted.app/gen/interfaces/ObjectDetector.html)
- [Scrypted Detection Example](https://github.com/koush/scrypted/blob/main/packages/client/examples/detection.ts)
- [OpenTelemetry JavaScript SDK](https://opentelemetry.io/docs/languages/js/)
- [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)
- [OpenTelemetry Metrics API](https://opentelemetry.io/docs/specs/otel/metrics/api/)

## License

See LICENSE file for details.
