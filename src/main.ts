import { ScryptedDeviceBase, Settings, Setting, SettingValue, ScryptedInterface, EventListenerRegister, ScryptedDevice, EventDetails, ObjectsDetected, ObjectDetector } from '@scrypted/sdk';
import sdk from '@scrypted/sdk';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

const { systemManager } = sdk;

interface OtelCollectorSettings {
    endpoint?: string;
    enabled?: boolean;
    eventFilter?: string;
    exportInterval?: number;
    deviceCooldown?: number; // Minimum seconds between metrics per device
}

class OtelCollectorPlugin extends ScryptedDeviceBase implements Settings {
    private meterProvider?: MeterProvider;
    private eventCounter?: any;
    private deviceListeners: Map<string, EventListenerRegister> = new Map();
    private lastEmissionTime: Map<string, number> = new Map(); // Track last emission timestamp per device
    private settings: OtelCollectorSettings = {
        enabled: false,
        exportInterval: 10000, // 10 seconds default
        deviceCooldown: 10, // 10 seconds default cooldown between metrics per device
    };

    constructor(nativeId?: string) {
        super(nativeId);

        // Load settings from storage
        this.loadSettings();

        // Initialize if already configured
        if (this.settings.enabled && this.settings.endpoint) {
            this.initialize();
        }
    }

    private loadSettings() {
        try {
            const endpoint = this.storage.getItem('endpoint');
            this.settings.endpoint = endpoint || undefined;
            this.settings.enabled = this.storage.getItem('enabled') === 'true';
            this.settings.eventFilter = this.storage.getItem('eventFilter') || '';
            this.settings.exportInterval = parseInt(this.storage.getItem('exportInterval') || '10000');
            this.settings.deviceCooldown = parseInt(this.storage.getItem('deviceCooldown') || '10');
        } catch (error) {
            this.console.error('Failed to load settings:', error);
        }
    }

    private saveSettings() {
        try {
            if (this.settings.endpoint) {
                this.storage.setItem('endpoint', this.settings.endpoint);
            }
            this.storage.setItem('enabled', this.settings.enabled ? 'true' : 'false');
            this.storage.setItem('eventFilter', this.settings.eventFilter || '');
            this.storage.setItem('exportInterval', this.settings.exportInterval?.toString() || '10000');
            this.storage.setItem('deviceCooldown', this.settings.deviceCooldown?.toString() || '10');
        } catch (error) {
            this.console.error('Failed to save settings:', error);
        }
    }

    private validateEndpoint(endpoint: string): boolean {
        try {
            const url = new URL(endpoint);
            // Only allow http and https protocols to prevent SSRF
            if (!['http:', 'https:'].includes(url.protocol)) {
                this.console.error(`Invalid protocol: ${url.protocol}. Only http and https are allowed.`);
                return false;
            }
            return true;
        } catch (error) {
            this.console.error('Invalid endpoint URL:', error);
            return false;
        }
    }

    private initialize() {
        if (!this.settings.endpoint) {
            this.console.error('Cannot initialize: endpoint not configured');
            return;
        }

        if (!this.validateEndpoint(this.settings.endpoint)) {
            this.console.error('Cannot initialize: invalid endpoint');
            this.settings.enabled = false;
            this.saveSettings();
            return;
        }

        try {
            // Cleanup existing resources
            this.cleanup();

            // Enable OTEL diagnostic logging to capture collector responses
            // Route through Scrypted's console logger
            diag.setLogger({
                verbose: (message: string, ...args: any[]) => this.console.log(`[OTEL] ${message}`, ...args),
                debug: (message: string, ...args: any[]) => this.console.log(`[OTEL DEBUG] ${message}`, ...args),
                info: (message: string, ...args: any[]) => this.console.log(`[OTEL INFO] ${message}`, ...args),
                warn: (message: string, ...args: any[]) => this.console.warn(`[OTEL WARN] ${message}`, ...args),
                error: (message: string, ...args: any[]) => this.console.error(`[OTEL ERROR] ${message}`, ...args),
            }, DiagLogLevel.INFO);

            // Create OTEL meter provider
            const resource = Resource.default().merge(
                new Resource({
                    [ATTR_SERVICE_NAME]: 'scrypted-otel-collector',
                    [ATTR_SERVICE_VERSION]: '0.1.0',
                })
            );

            const metricExporter = new OTLPMetricExporter({
                url: this.settings.endpoint,
            });

            const metricReader = new PeriodicExportingMetricReader({
                exporter: metricExporter,
                exportIntervalMillis: this.settings.exportInterval || 10000,
            });

            this.meterProvider = new MeterProvider({
                resource,
                readers: [metricReader],
            });

            const meter = this.meterProvider.getMeter('scrypted-events', '0.1.0');

            // Create counter for event counts
            this.eventCounter = meter.createCounter('scrypted.events.total', {
                description: 'Total count of Scrypted events by device and interface',
                unit: '1',
            });

            // Discover and subscribe to camera/detector devices
            this.setupDeviceListeners();

            this.console.log(`OTEL Collector plugin initialized successfully. Endpoint: ${this.settings.endpoint}`);
        } catch (error) {
            this.console.error('Failed to initialize OTEL Collector plugin:', error);
            this.settings.enabled = false;
            this.saveSettings();
        }
    }

    private handleEvent(eventSource: ScryptedDevice | undefined, eventDetails: EventDetails, eventData: any) {
        if (!this.settings.enabled || !this.eventCounter) {
            return;
        }

        try {
            // Skip system events without a device source
            if (!eventSource || !eventSource.id) {
                return;
            }

            const results = eventData as ObjectsDetected;

            // Only process detections that have been flagged for retention (deduplicated by Scrypted NVR)
            // detectionId indicates this is a "real" detection event, not frame-by-frame noise
            if (!results.detectionId) {
                return;
            }

            // Check device cooldown - skip if we recently sent a metric for this device
            const deviceId = eventSource.id;
            const now = Date.now();
            const lastEmission = this.lastEmissionTime.get(deviceId);
            const cooldownMs = (this.settings.deviceCooldown || 10) * 1000;

            if (lastEmission && (now - lastEmission) < cooldownMs) {
                const timeRemaining = Math.ceil((cooldownMs - (now - lastEmission)) / 1000);
                this.console.log(`[COOLDOWN] Skipping event from ${eventSource.name} - ${timeRemaining}s remaining`);
                return;
            }

            this.console.log('=== DETECTION EVENT (with detectionId) ===');
            this.console.log(`Device: ${eventSource.name} (${eventSource.id})`);
            this.console.log(`Detection ID: ${results.detectionId}`);
            this.console.log(`Timestamp: ${results.timestamp}`);

            // Process each detection in this event
            let metricsEmitted = false;
            const emittedClassNames = new Set<string>(); // Track unique classNames in this event

            if (results.detections && Array.isArray(results.detections)) {
                this.console.log(`Detections: ${results.detections.length}`);

                for (const detection of results.detections) {
                    const className = detection.className || 'unknown';
                    const score = detection.score || 0;

                    this.console.log(`  - ${className} (score: ${score.toFixed(2)})`);

                    // Check if this detection class should be filtered based on settings
                    if (this.settings.eventFilter) {
                        const filters = this.settings.eventFilter.split(',').map(f => f.trim()).filter(f => f);
                        const shouldSkip = filters.some(filter => className.toLowerCase().includes(filter.toLowerCase()));
                        if (shouldSkip) {
                            this.console.log(`    Filtered out by settings: ${className}`);
                            continue;
                        }
                    }

                    // Only emit one metric per unique className per event
                    if (emittedClassNames.has(className)) {
                        this.console.log(`    Skipped duplicate className: ${className}`);
                        continue;
                    }

                    // Create metrics for this detection
                    const attributes = {
                        'scrypted.device.id': eventSource.id,
                        'scrypted.device.name': eventSource.name || 'unknown',
                        'scrypted.device.type': eventSource.type || 'unknown',
                        'scrypted.detection.class': className,
                        'scrypted.detection.score': score.toFixed(2),
                        'scrypted.detection.id': results.detectionId,
                    };

                    // Increment detection counter
                    this.eventCounter.add(1, attributes);
                    this.console.log(`    Metric emitted for ${className}`);
                    emittedClassNames.add(className);
                    metricsEmitted = true;
                }
            }

            // Update last emission time if we actually emitted any metrics
            if (metricsEmitted) {
                this.lastEmissionTime.set(deviceId, now);
            }

            this.console.log('=========================================');
        } catch (error) {
            this.console.error('Failed to handle event:', error);
        }
    }

    private setupDeviceListeners() {
        try {
            // Get all devices in the system
            const systemState = systemManager.getSystemState();

            this.console.log(`Found ${Object.keys(systemState).length} devices in system`);

            for (const deviceId in systemState) {
                const deviceState = systemState[deviceId];

                // Check if device is a camera or has object detection
                const isCamera = deviceState.type?.value === 'Camera';
                const hasObjectDetector = deviceState.interfaces?.value?.includes('ObjectDetector');
                const hasMotionSensor = deviceState.interfaces?.value?.includes('MotionSensor');

                if (isCamera || hasObjectDetector || hasMotionSensor) {
                    try {
                        const device = systemManager.getDeviceById<ObjectDetector>(deviceId);

                        this.console.log(`Subscribing to device: ${deviceState.name?.value} (${deviceId})`);
                        this.console.log(`  Type: ${deviceState.type?.value}`);
                        this.console.log(`  Interfaces: ${deviceState.interfaces?.value?.join(', ')}`);

                        // Listen specifically to ObjectDetector events
                        // This gives us deduplicated detection events with detectionId
                        const listener = device.listen(ScryptedInterface.ObjectDetector, (eventSource: ScryptedDevice | undefined, eventDetails: EventDetails, eventData: any) => {
                            this.handleEvent(eventSource, eventDetails, eventData);
                        });

                        this.deviceListeners.set(deviceId, listener);
                    } catch (error) {
                        this.console.error(`Failed to subscribe to device ${deviceId}:`, error);
                    }
                }
            }

            this.console.log(`Subscribed to ${this.deviceListeners.size} devices`);
        } catch (error) {
            this.console.error('Failed to setup device listeners:', error);
        }
    }

    private async cleanup() {
        // Remove all device listeners
        for (const [deviceId, listener] of this.deviceListeners) {
            try {
                listener.removeListener();
            } catch (error) {
                this.console.error(`Failed to remove listener for device ${deviceId}:`, error);
            }
        }
        this.deviceListeners.clear();

        // Shutdown meter provider
        if (this.meterProvider) {
            try {
                await this.meterProvider.shutdown();
            } catch (error) {
                this.console.error('Failed to shutdown meter provider:', error);
            }
            this.meterProvider = undefined;
            this.eventCounter = undefined;
        }
    }

    async getSettings(): Promise<Setting[]> {
        return [
            {
                key: 'enabled',
                title: 'Enable OTEL Collector',
                description: 'Enable forwarding Scrypted events to OpenTelemetry Collector',
                type: 'boolean',
                value: this.settings.enabled,
            },
            {
                key: 'endpoint',
                title: 'OTEL Collector Endpoint',
                description: 'HTTP/HTTPS endpoint for the OpenTelemetry Collector (e.g., http://localhost:4318/v1/metrics)',
                type: 'string',
                placeholder: 'http://localhost:4318/v1/metrics',
                value: this.settings.endpoint,
            },
            {
                key: 'eventFilter',
                title: 'Detection Class Filter',
                description: 'Comma-separated list of detection classes to SKIP (e.g., motion,person). Highly recommend filtering `motion,clip,plate` at minimum, it will still send `vehicle`, `person` etc. Empty = forward all',
                type: 'string',
                placeholder: 'motion,clip,plate',
                value: this.settings.eventFilter,
            },
            {
                key: 'exportInterval',
                title: 'Export Interval (ms)',
                description: 'How often to export metrics to the collector',
                type: 'number',
                value: this.settings.exportInterval,
                range: [1000, 60000],
            },
            {
                key: 'deviceCooldown',
                title: 'Device Cooldown (seconds)',
                description: 'Minimum seconds between metrics per device. Prevents flooding if multiple detections occur rapidly.',
                type: 'number',
                value: this.settings.deviceCooldown,
                range: [1, 300],
            },
        ];
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        this.console.log(`Setting ${key} to ${value}`);

        const oldEnabled = this.settings.enabled;
        const oldEndpoint = this.settings.endpoint;

        switch (key) {
            case 'enabled':
                this.settings.enabled = value === true || value === 'true';
                break;
            case 'endpoint':
                if (value && typeof value === 'string') {
                    if (!this.validateEndpoint(value)) {
                        throw new Error('Invalid endpoint URL. Only http and https protocols are allowed.');
                    }
                    this.settings.endpoint = value;
                }
                break;
            case 'eventFilter':
                this.settings.eventFilter = (value as string) || '';
                break;
            case 'exportInterval':
                this.settings.exportInterval = typeof value === 'number' ? value : parseInt(value as string);
                break;
            case 'deviceCooldown':
                this.settings.deviceCooldown = typeof value === 'number' ? value : parseInt(value as string);
                break;
        }

        this.saveSettings();

        // Reinitialize if settings changed and plugin is enabled
        const needsReinit =
            (this.settings.enabled && !oldEnabled) ||
            (this.settings.enabled && this.settings.endpoint !== oldEndpoint) ||
            (key === 'exportInterval');

        if (needsReinit) {
            this.initialize();
        } else if (!this.settings.enabled && oldEnabled) {
            await this.cleanup();
            this.console.log('OTEL Collector plugin disabled');
        }
    }
}

export default OtelCollectorPlugin;
