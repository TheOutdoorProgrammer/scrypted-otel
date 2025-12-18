# Scrypted OpenTelemetry Collector Plugin

Forward Scrypted events to an OpenTelemetry Collector for observability, monitoring, and analysis.

## Features

- **System-wide event monitoring**: Listens to all device events in Scrypted
- **Flexible filtering**: Configure which events to forward using interface/property filters
- **Batching**: Efficient batch processing to reduce network overhead
- **Security**: URL validation to prevent SSRF attacks
- **Configurable**: All settings managed through Scrypted UI

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure OTEL Collector

Ensure you have an OpenTelemetry Collector running and accessible. The collector should accept logs via HTTP at the OTLP endpoint.

Example collector config (`otel-collector-config.yaml`):

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

exporters:
  logging:
    loglevel: debug
  # Add your preferred exporters (e.g., Jaeger, Prometheus, etc.)

service:
  pipelines:
    logs:
      receivers: [otlp]
      exporters: [logging]
```

Run the collector:

```bash
docker run -p 4318:4318 \
  -v $(pwd)/otel-collector-config.yaml:/etc/otel-collector-config.yaml \
  otel/opentelemetry-collector:latest \
  --config=/etc/otel-collector-config.yaml
```

### 3. Deploy Plugin to Scrypted

1. Open the project in VS Code
2. Edit `.vscode/settings.json` to point to your Scrypted server IP (default: `127.0.0.1`)
3. Press Launch (green arrow in Run and Debug sidebar) to deploy the plugin
4. If prompted, authenticate with `npx scrypted login`

### 4. Configure Plugin in Scrypted

1. Navigate to the plugin in Scrypted Management Console
2. Configure the following settings:
   - **Enable OTEL Collector**: Toggle to enable/disable event forwarding
   - **OTEL Collector Endpoint**: The HTTP endpoint for your collector (e.g., `http://localhost:4318/v1/logs`)
   - **Event Filter**: Comma-separated list of interfaces/properties to forward (leave empty to forward all)
   - **Batch Size**: Maximum events to batch before sending (default: 100)
   - **Batch Timeout**: Maximum milliseconds to wait before sending batch (default: 5000)

## Configuration Examples

### Forward All Events

Leave the "Event Filter" field empty.

### Forward Specific Events

Enter comma-separated filters:

```
OnOff,Brightness,MotionSensor
```

This forwards only events related to switches, dimmable lights, and motion sensors.

### Performance Tuning

- **High-frequency environments**: Increase batch size to 500-1000, reduce timeout to 1000-2000ms
- **Low-frequency environments**: Decrease batch size to 10-50, increase timeout to 10000-30000ms

## Security Considerations

- **Protocol validation**: Only `http://` and `https://` endpoints are allowed
- **URL validation**: Endpoint URLs are validated to prevent SSRF attacks
- **Network access**: Ensure your OTEL collector is on a trusted network
- **Authentication**: Currently basic auth is not supported. Use network-level security (VPN, firewall rules) to protect the collector endpoint

## Event Data Structure

Events are sent as OTEL logs with the following attributes:

- `scrypted.event.property`: The event property that changed
- `scrypted.event.interface`: The Scrypted interface
- `scrypted.device.id`: Device identifier
- `scrypted.device.name`: Human-readable device name
- `scrypted.device.type`: Device type (e.g., Light, Camera, Sensor)
- `scrypted.event.timestamp`: Event timestamp
- `scrypted.event.data`: JSON-serialized event payload

## Development

### Build

```bash
npm run build
```

### Debug

1. Set breakpoints in VS Code
2. Press F5 to start debugging
3. Plugin will hot-reload on changes

## Troubleshooting

### Events not appearing in collector

1. Check plugin is enabled in settings
2. Verify collector endpoint is correct and accessible
3. Check Scrypted console logs for errors
4. Verify collector is receiving data (check collector logs)

### High CPU/memory usage

1. Reduce batch size
2. Add more specific event filters
3. Increase batch timeout to reduce send frequency

### Connection errors

1. Verify collector is running and accessible
2. Check firewall rules
3. Ensure endpoint URL includes the correct path (e.g., `/v1/logs`)

## References

- [Scrypted EventListener Documentation](https://developer.scrypted.app/gen/type-aliases/EventListener.html)
- [Scrypted SystemManager API](https://developer.scrypted.app/gen/interfaces/SystemManager.html)
- [OpenTelemetry JavaScript SDK](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/)
- [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)

## License

See LICENSE file for details.
