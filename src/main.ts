import { ScryptedDeviceBase, Settings, Setting, SettingValue, ScryptedInterface, EventListenerRegister, ScryptedDevice, EventDetails, SystemManager } from '@scrypted/sdk';
import sdk from '@scrypted/sdk';
import { logs } from '@opentelemetry/api-logs';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const { systemManager } = sdk;

interface OtelCollectorSettings {
    endpoint?: string;
    enabled?: boolean;
    eventFilter?: string;
    batchSize?: number;
    batchTimeout?: number;
}

class OtelCollectorPlugin extends ScryptedDeviceBase implements Settings {
    private loggerProvider?: LoggerProvider;
    private logger?: any;
    private eventListener?: EventListenerRegister;
    private settings: OtelCollectorSettings = {
        enabled: false,
        batchSize: 100,
        batchTimeout: 5000,
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
            this.settings.batchSize = parseInt(this.storage.getItem('batchSize') || '100');
            this.settings.batchTimeout = parseInt(this.storage.getItem('batchTimeout') || '5000');
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
            this.storage.setItem('batchSize', this.settings.batchSize?.toString() || '100');
            this.storage.setItem('batchTimeout', this.settings.batchTimeout?.toString() || '5000');
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

    private shouldForwardEvent(eventInterface?: ScryptedInterface, eventProperty?: string): boolean {
        if (!this.settings.eventFilter) {
            return true;
        }

        const filters = this.settings.eventFilter.split(',').map(f => f.trim()).filter(f => f);
        if (filters.length === 0) {
            return true;
        }

        // Check if event interface or property matches any filter
        return filters.some(filter => {
            if (eventInterface && eventInterface.includes(filter)) {
                return true;
            }
            if (eventProperty && eventProperty.includes(filter)) {
                return true;
            }
            return false;
        });
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

            // Create OTEL logger provider
            const resource = Resource.default().merge(
                new Resource({
                    [ATTR_SERVICE_NAME]: 'scrypted-otel-collector',
                    [ATTR_SERVICE_VERSION]: '0.1.0',
                })
            );

            const logExporter = new OTLPLogExporter({
                url: this.settings.endpoint,
            });

            const logRecordProcessor = new BatchLogRecordProcessor(logExporter, {
                maxQueueSize: this.settings.batchSize || 100,
                scheduledDelayMillis: this.settings.batchTimeout || 5000,
            });

            this.loggerProvider = new LoggerProvider({ resource });
            this.loggerProvider.addLogRecordProcessor(logRecordProcessor);

            logs.setGlobalLoggerProvider(this.loggerProvider);
            this.logger = logs.getLogger('scrypted-events', '0.1.0');

            // Setup event listener
            this.eventListener = systemManager.listen((eventSource: ScryptedDevice | undefined, eventDetails: EventDetails, eventData: any) => {
                this.handleEvent(eventSource, eventDetails, eventData);
            });

            this.console.log(`OTEL Collector plugin initialized successfully. Endpoint: ${this.settings.endpoint}`);
        } catch (error) {
            this.console.error('Failed to initialize OTEL Collector plugin:', error);
            this.settings.enabled = false;
            this.saveSettings();
        }
    }

    private handleEvent(eventSource: ScryptedDevice | undefined, eventDetails: EventDetails, eventData: any) {
        if (!this.settings.enabled || !this.logger) {
            return;
        }

        try {
            const eventInterface = eventDetails?.property as ScryptedInterface;

            // Apply filtering
            if (!this.shouldForwardEvent(eventInterface, eventDetails?.property)) {
                return;
            }

            // Create log record with event data
            const logRecord = {
                severityText: 'INFO',
                body: `Scrypted event: ${eventDetails?.property || 'unknown'}`,
                attributes: {
                    'scrypted.event.property': eventDetails?.property || 'unknown',
                    'scrypted.event.interface': eventInterface || 'unknown',
                    'scrypted.device.id': eventSource?.id || 'unknown',
                    'scrypted.device.name': eventSource?.name || 'unknown',
                    'scrypted.device.type': eventSource?.type || 'unknown',
                    'scrypted.event.timestamp': eventDetails?.eventTime || Date.now(),
                    'scrypted.event.data': JSON.stringify(eventData),
                },
            };

            this.logger.emit(logRecord);
        } catch (error) {
            this.console.error('Failed to handle event:', error);
        }
    }

    private cleanup() {
        // Remove event listener
        if (this.eventListener) {
            this.eventListener.removeListener();
            this.eventListener = undefined;
        }

        // Shutdown logger provider
        if (this.loggerProvider) {
            this.loggerProvider.shutdown().catch((error: any) => {
                this.console.error('Failed to shutdown logger provider:', error);
            });
            this.loggerProvider = undefined;
            this.logger = undefined;
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
                description: 'HTTP/HTTPS endpoint for the OpenTelemetry Collector (e.g., http://localhost:4318/v1/logs)',
                type: 'string',
                placeholder: 'http://localhost:4318/v1/logs',
                value: this.settings.endpoint,
            },
            {
                key: 'eventFilter',
                title: 'Event Filter',
                description: 'Comma-separated list of event interfaces/properties to forward (empty = forward all)',
                type: 'string',
                placeholder: 'OnOff,Brightness,MotionSensor',
                value: this.settings.eventFilter,
            },
            {
                key: 'batchSize',
                title: 'Batch Size',
                description: 'Maximum number of events to batch before sending',
                type: 'number',
                value: this.settings.batchSize,
                range: [1, 1000],
            },
            {
                key: 'batchTimeout',
                title: 'Batch Timeout (ms)',
                description: 'Maximum time to wait before sending a batch',
                type: 'number',
                value: this.settings.batchTimeout,
                range: [100, 30000],
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
            case 'batchSize':
                this.settings.batchSize = typeof value === 'number' ? value : parseInt(value as string);
                break;
            case 'batchTimeout':
                this.settings.batchTimeout = typeof value === 'number' ? value : parseInt(value as string);
                break;
        }

        this.saveSettings();

        // Reinitialize if settings changed and plugin is enabled
        const needsReinit =
            (this.settings.enabled && !oldEnabled) ||
            (this.settings.enabled && this.settings.endpoint !== oldEndpoint) ||
            (key === 'batchSize' || key === 'batchTimeout');

        if (needsReinit) {
            this.initialize();
        } else if (!this.settings.enabled && oldEnabled) {
            this.cleanup();
            this.console.log('OTEL Collector plugin disabled');
        }
    }
}

export default OtelCollectorPlugin;
