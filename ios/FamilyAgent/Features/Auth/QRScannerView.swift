import SwiftUI
@preconcurrency import AVFoundation

/// A full-screen QR scanner used to pair with the desktop app. The desktop
/// Settings screen ("Pair a phone") shows a QR that encodes either the home
/// server's `http://host:port` address as a plain string, or a JSON envelope
/// `{"url": "...", "name": "...", "t": "<token>"}` where `t` auto-signs the
/// phone into that account. Parsed by `PairingPayload`.
struct QRScanSheet: View {
    /// Called with the raw payload string once a code is read. The caller
    /// dismisses the sheet and routes it through `PairingPayload`.
    let onScan: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var permission = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var handled = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            switch permission {
            case .authorized:
                QRCameraView { payload in
                    guard !handled else { return }
                    handled = true
                    onScan(payload)
                    dismiss()
                }
                .ignoresSafeArea()
                overlay
            case .notDetermined:
                ProgressView().tint(.white)
                    .task {
                        _ = await AVCaptureDevice.requestAccess(for: .video)
                        permission = AVCaptureDevice.authorizationStatus(for: .video)
                    }
            default:
                deniedView
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Cancel") { dismiss() }.tint(.white)
            }
        }
        .toolbarBackground(.black, for: .navigationBar)
    }

    private var overlay: some View {
        VStack {
            Spacer()
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(.white.opacity(0.85), lineWidth: 3)
                .frame(width: 240, height: 240)
            Text("Point at the QR code on the desktop app\n(Settings → Pair a phone)")
                .font(.inter(14))
                .multilineTextAlignment(.center)
                .foregroundStyle(.white)
                .padding(.top, 20)
            Spacer()
        }
        .padding()
    }

    private var deniedView: some View {
        VStack(spacing: 14) {
            Image(systemName: "camera.fill").font(.system(size: 34)).foregroundStyle(.white)
            Text("Camera access is off")
                .font(.inter(17, .semibold)).foregroundStyle(.white)
            Text("Allow camera access for Family Agent in Settings to scan a pairing code.")
                .font(.inter(14)).foregroundStyle(.white.opacity(0.8))
                .multilineTextAlignment(.center)
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            .buttonStyle(.primary)
        }
        .padding(32)
    }
}

/// `UIViewRepresentable` around an `AVCaptureSession` wired for QR metadata.
/// Mirrors the `SafariView` / `PDFPreview` representable pattern.
private struct QRCameraView: UIViewRepresentable {
    let onCode: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        context.coordinator.attach(to: view)
        return view
    }
    func updateUIView(_ uiView: PreviewView, context: Context) {}

    static func dismantleUIView(_ uiView: PreviewView, coordinator: Coordinator) {
        coordinator.stop()
    }

    /// A `UIView` whose backing layer is the camera preview.
    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        private let onCode: (String) -> Void
        private let session = AVCaptureSession()
        private let queue = DispatchQueue(label: "qr.capture")
        private var done = false

        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        // PreviewView is a UIView subclass (implicitly main-actor-isolated);
        // this is only ever called from makeUIView, itself @MainActor per
        // the UIViewRepresentable protocol requirement, so this is a real
        // MainActor context, not just a nonisolated method the compiler
        // can't see is always called from one.
        @MainActor
        func attach(to view: PreviewView) {
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input) else { return }
            session.addInput(input)

            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes =
                output.availableMetadataObjectTypes.contains(.qr) ? [.qr] : []

            view.previewLayer.session = session
            view.previewLayer.videoGravity = .resizeAspectFill

            queue.async { [session] in session.startRunning() }
        }

        func stop() {
            queue.async { [session] in if session.isRunning { session.stopRunning() } }
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput,
                            didOutput metadataObjects: [AVMetadataObject],
                            from connection: AVCaptureConnection) {
            guard !done,
                  let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  obj.type == .qr, let value = obj.stringValue else { return }
            done = true
            stop()
            onCode(value)
        }
    }
}

/// A scanned pairing QR. The desktop encodes either a bare `http(s)://…`
/// string (address only) or a `{"url": "...", "name": "...", "t": "<token>"}`
/// JSON envelope — `t` is a single-use token that signs the phone straight into
/// the desktop's account (see `AppModel.redeemPairing`).
struct PairingPayload {
    let serverURL: String
    let serverName: String?
    /// Present when the desktop had "sign in automatically" enabled.
    let token: String?

    static func parse(from raw: String) -> PairingPayload? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = trimmed.lowercased()
        if lower.hasPrefix("http://") || lower.hasPrefix("https://") {
            return PairingPayload(serverURL: trimmed, serverName: nil, token: nil)
        }
        if let data = trimmed.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let url = obj["url"] as? String,
           url.lowercased().hasPrefix("http") {
            let token = (obj["t"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            return PairingPayload(serverURL: url, serverName: obj["name"] as? String, token: token)
        }
        return nil
    }
}
