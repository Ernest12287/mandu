export {
  eventBus,
  type ObservabilityEvent,
  type EventType,
  type ObservabilitySeverity,
  type EventHandler,
} from "./event-bus";
export { connectLoggerToEventBus } from "./logger-adapter";
