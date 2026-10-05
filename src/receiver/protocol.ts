import { escapeXML, xmlResponse } from './xml';

export const ROOT = '/dlna';
export const TYPES = {
  AVTransport: 'urn:schemas-upnp-org:service:AVTransport:1',
  RenderingControl: 'urn:schemas-upnp-org:service:RenderingControl:1',
  ConnectionManager: 'urn:schemas-upnp-org:service:ConnectionManager:1',
} as const;
export type ServiceName = keyof typeof TYPES;
export const DEVICE = 'urn:schemas-upnp-org:device:MediaRenderer:1';
export const PROTOCOL_INFO = 'http-get:*:audio/mpeg:*';
export const SSDP_GROUP = '239.255.255.250';
export const SSDP_ADDR = `${SSDP_GROUP}:1900`;

// Action arguments: [name, direction, related state variable].
type Arg = [string, 'in' | 'out', string];
type Variable = [string, string, string[]?, string?];
interface Schema { actions: Record<string, Arg[]>; variables: Record<string, Variable>; }
const instance: Arg = ['InstanceID', 'in', 'A_ARG_TYPE_InstanceID'];
const channel: Arg = ['Channel', 'in', 'A_ARG_TYPE_Channel'];
export const SCHEMAS: Record<ServiceName, Schema> = {
  AVTransport: {
    actions: {
      SetAVTransportURI: [instance, ['CurrentURI', 'in', 'AVTransportURI'], ['CurrentURIMetaData', 'in', 'AVTransportURIMetaData']],
      Play: [instance, ['Speed', 'in', 'TransportPlaySpeed']],
      Pause: [instance], Stop: [instance],
      GetTransportInfo: [instance, ['CurrentTransportState', 'out', 'TransportState'], ['CurrentTransportStatus', 'out', 'TransportStatus'], ['CurrentSpeed', 'out', 'TransportPlaySpeed']],
      GetPositionInfo: [instance, ['Track', 'out', 'CurrentTrack'], ['TrackDuration', 'out', 'CurrentTrackDuration'], ['TrackMetaData', 'out', 'CurrentTrackMetaData'], ['TrackURI', 'out', 'CurrentTrackURI'], ['RelTime', 'out', 'RelativeTimePosition'], ['AbsTime', 'out', 'AbsoluteTimePosition'], ['RelCount', 'out', 'RelativeCounterPosition'], ['AbsCount', 'out', 'AbsoluteCounterPosition']],
      GetMediaInfo: [instance, ['NrTracks', 'out', 'NumberOfTracks'], ['MediaDuration', 'out', 'CurrentMediaDuration'], ['CurrentURI', 'out', 'AVTransportURI'], ['CurrentURIMetaData', 'out', 'AVTransportURIMetaData'], ['NextURI', 'out', 'NextAVTransportURI'], ['NextURIMetaData', 'out', 'NextAVTransportURIMetaData'], ['PlayMedium', 'out', 'PlaybackStorageMedium'], ['RecordMedium', 'out', 'RecordStorageMedium'], ['WriteStatus', 'out', 'RecordMediumWriteStatus']],
      GetDeviceCapabilities: [instance, ['PlayMedia', 'out', 'PossiblePlaybackStorageMedia'], ['RecMedia', 'out', 'PossibleRecordStorageMedia'], ['RecQualityModes', 'out', 'PossibleRecordQualityModes']],
      GetTransportSettings: [instance, ['PlayMode', 'out', 'CurrentPlayMode'], ['RecQualityMode', 'out', 'CurrentRecordQualityMode']],
      GetCurrentTransportActions: [instance, ['Actions', 'out', 'CurrentTransportActions']],
    },
    variables: {
      A_ARG_TYPE_InstanceID: ['ui4', '0'], LastChange: ['string', '', undefined, 'yes'],
      AVTransportURI: ['uri', ''], AVTransportURIMetaData: ['string', ''],
      NextAVTransportURI: ['uri', ''], NextAVTransportURIMetaData: ['string', ''],
      TransportState: ['string', 'NO_MEDIA_PRESENT', ['STOPPED', 'PLAYING', 'TRANSITIONING', 'PAUSED_PLAYBACK', 'NO_MEDIA_PRESENT']],
      TransportStatus: ['string', 'OK', ['OK', 'ERROR_OCCURRED']], TransportPlaySpeed: ['string', '1', ['1']],
      CurrentTrack: ['ui4', '0'], NumberOfTracks: ['ui4', '0'], CurrentTrackDuration: ['string', '00:00:00'], CurrentMediaDuration: ['string', '00:00:00'],
      CurrentTrackMetaData: ['string', ''], CurrentTrackURI: ['uri', ''], RelativeTimePosition: ['string', '00:00:00'], AbsoluteTimePosition: ['string', 'NOT_IMPLEMENTED'],
      RelativeCounterPosition: ['i4', '2147483647'], AbsoluteCounterPosition: ['i4', '2147483647'],
      PlaybackStorageMedium: ['string', 'NETWORK', ['NONE', 'NETWORK']], RecordStorageMedium: ['string', 'NOT_IMPLEMENTED', ['NOT_IMPLEMENTED']],
      RecordMediumWriteStatus: ['string', 'NOT_IMPLEMENTED', ['NOT_IMPLEMENTED']], PossiblePlaybackStorageMedia: ['string', 'NETWORK'],
      PossibleRecordStorageMedia: ['string', 'NOT_IMPLEMENTED'], PossibleRecordQualityModes: ['string', 'NOT_IMPLEMENTED'],
      CurrentPlayMode: ['string', 'NORMAL', ['NORMAL']], CurrentRecordQualityMode: ['string', 'NOT_IMPLEMENTED', ['NOT_IMPLEMENTED']], CurrentTransportActions: ['string', ''],
    },
  },
  RenderingControl: {
    actions: {
      ListPresets: [instance, ['CurrentPresetNameList', 'out', 'PresetNameList']],
      SelectPreset: [instance, ['PresetName', 'in', 'A_ARG_TYPE_PresetName']],
      GetVolume: [instance, channel, ['CurrentVolume', 'out', 'Volume']],
      SetVolume: [instance, channel, ['DesiredVolume', 'in', 'Volume']],
    },
    variables: {
      A_ARG_TYPE_InstanceID: ['ui4', '0'], A_ARG_TYPE_Channel: ['string', 'Master', ['Master']],
      A_ARG_TYPE_PresetName: ['string', 'FactoryDefaults', ['FactoryDefaults']], PresetNameList: ['string', 'FactoryDefaults'],
      Volume: ['ui2', '0'], LastChange: ['string', '', undefined, 'yes']
    },
  },
  ConnectionManager: {
    actions: {
      GetProtocolInfo: [['Source', 'out', 'SourceProtocolInfo'], ['Sink', 'out', 'SinkProtocolInfo']],
      GetCurrentConnectionIDs: [['ConnectionIDs', 'out', 'CurrentConnectionIDs']],
      GetCurrentConnectionInfo: [['ConnectionID', 'in', 'A_ARG_TYPE_ConnectionID'], ['RcsID', 'out', 'A_ARG_TYPE_RcsID'], ['AVTransportID', 'out', 'A_ARG_TYPE_AVTransportID'], ['ProtocolInfo', 'out', 'A_ARG_TYPE_ProtocolInfo'], ['PeerConnectionManager', 'out', 'A_ARG_TYPE_ConnectionManager'], ['PeerConnectionID', 'out', 'A_ARG_TYPE_ConnectionID'], ['Direction', 'out', 'A_ARG_TYPE_Direction'], ['Status', 'out', 'A_ARG_TYPE_ConnectionStatus']],
    },
    variables: {
      SourceProtocolInfo: ['string', '', undefined, 'yes'], SinkProtocolInfo: ['string', PROTOCOL_INFO, undefined, 'yes'], CurrentConnectionIDs: ['string', '0', undefined, 'yes'],
      A_ARG_TYPE_ConnectionID: ['i4', '0'], A_ARG_TYPE_RcsID: ['i4', '0'], A_ARG_TYPE_AVTransportID: ['i4', '0'], A_ARG_TYPE_ProtocolInfo: ['string', PROTOCOL_INFO],
      A_ARG_TYPE_ConnectionManager: ['string', ''], A_ARG_TYPE_Direction: ['string', 'Input', ['Input', 'Output']], A_ARG_TYPE_ConnectionStatus: ['string', 'OK', ['OK', 'ContentFormatMismatch', 'InsufficientBandwidth', 'UnreliableChannel', 'Unknown']]
    },
  },
};

export function scpd(service: ServiceName) {
  const schema = SCHEMAS[service];
  const actions = Object.entries(schema.actions).map(([name, args]) => `<action><name>${name}</name><argumentList>${args.map(([n, d, v]) => `<argument><name>${n}</name><direction>${d}</direction><relatedStateVariable>${v}</relatedStateVariable></argument>`).join('')}</argumentList></action>`).join('');
  const variables = Object.entries(schema.variables).map(([name, [type, value, allowed, event]]) => `<stateVariable sendEvents="${event || 'no'}"><name>${name}</name><dataType>${type}</dataType><defaultValue>${escapeXML(value)}</defaultValue>${allowed ? `<allowedValueList>${allowed.map(v => `<allowedValue>${escapeXML(v)}</allowedValue>`).join('')}</allowedValueList>` : ''}${name === 'Volume' ? '<allowedValueRange><minimum>0</minimum><maximum>100</maximum><step>1</step></allowedValueRange>' : ''}</stateVariable>`).join('');
  return xmlResponse(`<scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><actionList>${actions}</actionList><serviceStateTable>${variables}</serviceStateTable></scpd>`);
}

export function description(name: string, uuid: string, base: string) {
  // Some senders prepend the server origin even to absolute URLs. Keep the deployment path.
  const basePath = base.replace(/^https?:\/\/[^/]+/i, '');
  const services = Object.entries(TYPES).map(([key, type]) => `<service><serviceType>${type}</serviceType><serviceId>urn:upnp-org:serviceId:${key}</serviceId><SCPDURL>${escapeXML(basePath + ROOT + '/' + key + '.xml')}</SCPDURL><controlURL>${escapeXML(basePath + ROOT + '/' + key + '/control')}</controlURL><eventSubURL>${escapeXML(basePath + ROOT + '/' + key + '/event')}</eventSubURL></service>`).join('');
  return xmlResponse(`<root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><device><deviceType>${DEVICE}</deviceType><friendlyName>${escapeXML(name)}</friendlyName><manufacturer>Songloft</manufacturer><modelName>MIoT DLNA Receiver</modelName><UDN>${uuid}</UDN><serviceList>${services}</serviceList></device></root>`);
}

export function soapResult(service: ServiceName, action: string, values: Record<string, unknown>) {
  return xmlResponse(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action}Response xmlns:u="${TYPES[service]}">${Object.entries(values).map(([k, v]) => `<${k}>${escapeXML(v)}</${k}>`).join('')}</u:${action}Response></s:Body></s:Envelope>`);
}

export class UPnPError extends Error {
  constructor(public code: number, message: string) { super(message); }
}
export function soapFault(code: number, message: string) {
  return xmlResponse(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${escapeXML(message)}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`, 500);
}

export function clock(seconds: number): string {
  const n = Math.max(0, Math.floor(seconds));
  return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60].map(v => String(v).padStart(2, '0')).join(':');
}
