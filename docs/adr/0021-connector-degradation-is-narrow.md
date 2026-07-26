# Connector degradation is narrow

When a Capability Connection loses authorization, expires, is revoked, or loses a required scope, the Companion enters Capability Degradation for that connection. It suspends only dependent Tasks and Standing Directives, records the reason, and asks the person to reconnect or reauthorize it. Unrelated capabilities remain available. This avoids both unsafe retries using invalid access and a single broken service disabling the Companion.
