import QRCode from "qrcode";

/**
 * Render `text` as a QR code PNG data URI, for the "Pair a phone" panel in
 * Settings. The iOS app's scanner (`PairingPayload`) accepts a bare
 * `http://host:port` string, which is what we encode.
 */
export async function qrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, {
    margin: 1,
    width: 220,
    errorCorrectionLevel: "M",
    color: { dark: "#1e1b18", light: "#fcfbfa" },
  });
}
