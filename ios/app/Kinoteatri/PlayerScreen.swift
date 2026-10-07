// The player on screen: Apple's own player (AVPlayerViewController) presented full screen by UIKit
// from the top of the app, as Apple's apps show films. The video fills the screen and turns with
// the phone; the player's own close button (or a swipe down) closes it; picture in picture works.
// The title is in the item's metadata. "Playback stopped / Try again" shows over the video when
// the stream fails. When the player leaves the screen (not into picture in picture) the core's
// session stops.

import AVKit
import Combine
import UIKit

/// AVKit calls its delegate on the main thread, hence `@preconcurrency`.
@MainActor
final class PlayerScreen: NSObject, @preconcurrency AVPlayerViewControllerDelegate {
    /// The play on screen or in picture in picture; one at a time.
    private(set) static var current: PlayerScreen?

    /// Set by the UI tests (KINO_UI_TEST=1): the player describes itself to them (PlayerProbeView).
    static let describesItself = ProcessInfo.processInfo.environment["KINO_UI_TEST"] == "1"

    let model: PlayerModel
    let controller = AVPlayerViewController()
    private let status = PlayerStatusView()
    private let probe = PlayerProbeView()
    private var subscriptions: Set<AnyCancellable> = []
    private var inPictureInPicture = false
    /// Coming back from picture in picture.
    private var restoring = false
    private var closeCheck: Task<Void, Never>?
    private(set) var isFinished = false

    /// Shows `playing` full screen over whatever is on screen.
    @discardableResult
    static func present(_ playing: Playing) -> PlayerScreen? {
        current?.finish()
        guard let top = topViewController() else {
            Diagnostics.shared.log("player: no window to show it in")
            let session = playing.play.session
            Task.detached { try? await KinoCore.shared.stop(session: session) }
            return nil
        }
        // The UI tests can start a film further in (KINO_UITEST_START_AT, seconds).
        let startAt = ProcessInfo.processInfo.environment["KINO_UITEST_START_AT"].flatMap { Double($0) }
        let screen = PlayerScreen(playing: playing, startAt: startAt)
        current = screen
        screen.model.start()
        // The search field can still hold the keyboard (hidden): it would come up over the
        // player with the player's own menu.
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        let pictureInPicture = AVPictureInPictureController.isPictureInPictureSupported() ? "supported" : "not supported"
        Diagnostics.shared.log("player: full screen, session \(playing.play.session), picture in picture \(pictureInPicture)")
        top.present(screen.controller, animated: true)
        return screen
    }

    private init(playing: Playing, startAt: Double?) {
        model = PlayerModel(playing: playing, startAt: startAt)
        super.init()
        controller.player = model.player
        controller.delegate = self
        controller.allowsPictureInPicturePlayback = true
        controller.canStartPictureInPictureAutomaticallyFromInline = true
        controller.videoGravity = .resizeAspect
        controller.modalPresentationStyle = .fullScreen
        controller.loadViewIfNeeded()
        if let overlay = controller.contentOverlayView {
            probe.fill(overlay)
        }
        probe.facts = { [weak self] in self?.facts() ?? "" }
        status.attach(to: controller.view)
        status.onRetry = { [weak self] in self?.model.retry() }
        status.onWindowChange = { [weak self] inWindow in self?.windowChanged(inWindow) }
        model.$failure.combineLatest(model.$retrying)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] failure, retrying in
                self?.status.show(failure: failure, retrying: retrying)
            }
            .store(in: &subscriptions)
    }

    /// The view controller to present from: the key window's root, or what it presents.
    static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        let windows = scene?.windows ?? []
        var top = (windows.first(where: \.isKeyWindow) ?? windows.first)?.rootViewController
        while let presented = top?.presentedViewController {
            top = presented
        }
        return top
    }

    /// Closes the player as its close button does.
    func close() {
        if controller.presentingViewController != nil, !controller.isBeingDismissed {
            controller.dismiss(animated: false)
        }
        finish()
    }

    /// Ends the play: the core's session stops; the player goes if it's still on screen.
    func finish() {
        guard !isFinished else { return }
        isFinished = true
        closeCheck?.cancel()
        subscriptions.removeAll()
        model.close()
        if Self.current === self {
            Self.current = nil
        }
        if controller.presentingViewController != nil, !controller.isBeingDismissed {
            controller.dismiss(animated: false)
        }
    }

    // MARK: Leaving the screen

    private func windowChanged(_ inWindow: Bool) {
        if inWindow {
            closeCheck?.cancel()
            restoring = false
            status.bringToFront()
        } else {
            checkClosed(after: 0.4)
        }
    }

    /// Looks again in a moment: the player was closed if it's neither on screen nor presented,
    /// nor in picture in picture.
    private func checkClosed(after seconds: Double) {
        closeCheck?.cancel()
        closeCheck = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.closeIfGone()
        }
    }

    private func closeIfGone() {
        guard !isFinished, !inPictureInPicture, !restoring else { return }
        guard controller.viewIfLoaded?.window == nil, controller.presentingViewController == nil else { return }
        Diagnostics.shared.log("player: closed by the person")
        finish()
    }

    // MARK: AVPlayerViewControllerDelegate

    func playerViewController(
        _ playerViewController: AVPlayerViewController,
        willEndFullScreenPresentationWithAnimationCoordinator coordinator: UIViewControllerTransitionCoordinator
    ) {
        checkClosed(after: 1)
    }

    func playerViewControllerWillStartPictureInPicture(_ playerViewController: AVPlayerViewController) {
        inPictureInPicture = true
        Diagnostics.shared.log("player: picture in picture")
    }

    func playerViewController(_ playerViewController: AVPlayerViewController, failedToStartPictureInPictureWithError error: Error) {
        inPictureInPicture = false
        Diagnostics.shared.log("player: picture in picture failed: \(PlayerModel.brief(error))")
        checkClosed(after: 0.4)
    }

    func playerViewControllerDidStopPictureInPicture(_ playerViewController: AVPlayerViewController) {
        inPictureInPicture = false
        Diagnostics.shared.log("player: picture in picture ended")
        checkClosed(after: 0.4)
    }

    func playerViewController(
        _ playerViewController: AVPlayerViewController,
        restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void
    ) {
        guard !isFinished else {
            completionHandler(false)
            return
        }
        if controller.viewIfLoaded?.window != nil || controller.presentingViewController != nil {
            completionHandler(true)
            return
        }
        guard let top = Self.topViewController() else {
            completionHandler(false)
            return
        }
        restoring = true
        Diagnostics.shared.log("player: back from picture in picture")
        top.present(controller, animated: true) {
            completionHandler(true)
        }
    }

    // MARK: For the UI tests

    /// "player=0,0,402x874; window=402x874; video=0,353,402x168; orientation=portrait;
    /// subtitles=en; options=en; cue=no; time=12"
    private func facts() -> String {
        guard let view = controller.viewIfLoaded, let window = view.window else { return "window=none" }
        let frame = view.convert(view.bounds, to: window)
        let landscape = window.windowScene?.interfaceOrientation.isLandscape ?? (window.bounds.width > window.bounds.height)
        let time = model.player.currentTime().seconds
        return [
            "player=\(Self.text(frame))",
            "window=\(Self.text(window.bounds.size))",
            "video=\(Self.text(controller.videoBounds))",
            "orientation=\(landscape ? "landscape" : "portrait")",
            "subtitles=\(model.shownSubtitleLanguage ?? "off")",
            "options=\(model.subtitleOptions.joined(separator: ","))",
            "cue=\(model.cueShowing ? "yes" : "no")",
            "time=\(time.isFinite ? Int(time) : -1)",
        ].joined(separator: "; ")
    }

    private static func number(_ value: CGFloat) -> Int {
        value.isFinite ? Int(value.rounded()) : -1
    }

    private static func text(_ size: CGSize) -> String {
        "\(number(size.width))x\(number(size.height))"
    }

    private static func text(_ rect: CGRect) -> String {
        "\(number(rect.minX)),\(number(rect.minY)),\(text(rect.size))"
    }
}

/// "Playback stopped" (why, Try again, Copy diagnostics) or "Reconnecting…": a card in the middle of
/// the player, over the video and its controls; hidden while all is well. It also tells the player
/// screen when the player comes on screen or leaves it.
final class PlayerStatusView: UIView {
    var onRetry: (() -> Void)?
    var onWindowChange: ((Bool) -> Void)?

    private let card = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterialDark))
    private let failed = UIStackView()
    private let message = UILabel()
    private let retryButton = UIButton(type: .system)
    private let copyButton = UIButton(type: .system)
    private let reconnecting = UIStackView()

    init() {
        super.init(frame: .zero)
        build()
    }

    required init?(coder: NSCoder) {
        return nil
    }

    /// Centred in `container`, at most 360 points wide.
    func attach(to container: UIView) {
        translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(self)
        let preferredWidth = widthAnchor.constraint(equalToConstant: 360)
        preferredWidth.priority = .defaultHigh
        NSLayoutConstraint.activate([
            centerXAnchor.constraint(equalTo: container.centerXAnchor),
            centerYAnchor.constraint(equalTo: container.centerYAnchor),
            widthAnchor.constraint(lessThanOrEqualTo: container.widthAnchor, constant: -32),
            heightAnchor.constraint(lessThanOrEqualTo: container.heightAnchor, constant: -24),
            preferredWidth,
        ])
    }

    func show(failure: String?, retrying: Bool) {
        if let failure {
            message.text = failure
            failed.isHidden = false
            reconnecting.isHidden = true
            isHidden = false
        } else if retrying {
            failed.isHidden = true
            reconnecting.isHidden = false
            isHidden = false
        } else {
            isHidden = true
        }
        if !isHidden {
            bringToFront()
        }
    }

    /// Above the player's own views (it adds some once on screen).
    func bringToFront() {
        superview?.bringSubviewToFront(self)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        onWindowChange?(window != nil)
    }

    private func build() {
        isHidden = true
        accessibilityIdentifier = "playback-status"

        card.layer.cornerRadius = 18
        card.layer.cornerCurve = .continuous
        card.clipsToBounds = true
        card.translatesAutoresizingMaskIntoConstraints = false
        addSubview(card)

        let icon = UIImageView(image: UIImage(systemName: "exclamationmark.triangle.fill"))
        icon.tintColor = UIColor(named: "AccentColor") ?? .systemOrange
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .largeTitle)
        icon.contentMode = .scaleAspectFit

        let title = UILabel()
        title.text = "Playback stopped"
        title.font = .preferredFont(forTextStyle: .headline)
        title.textColor = .white
        title.textAlignment = .center

        message.font = .preferredFont(forTextStyle: .callout)
        message.textColor = UIColor.white.withAlphaComponent(0.75)
        message.textAlignment = .center
        message.numberOfLines = 5

        var retry = UIButton.Configuration.borderedProminent()
        retry.title = "Try again"
        retry.image = UIImage(systemName: "arrow.clockwise")
        retry.imagePadding = 6
        retryButton.configuration = retry
        retryButton.accessibilityIdentifier = "try-again"
        retryButton.addAction(UIAction { [weak self] _ in self?.onRetry?() }, for: .touchUpInside)

        copyButton.configuration = Self.copyConfiguration(copied: false)
        copyButton.accessibilityIdentifier = "copy-diagnostics"
        copyButton.addAction(UIAction { [weak self] _ in self?.copyDiagnostics() }, for: .touchUpInside)

        failed.axis = .vertical
        failed.alignment = .fill
        failed.spacing = 12
        for view in [icon, title, message, retryButton, copyButton] {
            failed.addArrangedSubview(view)
        }
        failed.setCustomSpacing(4, after: retryButton)

        let spinner = UIActivityIndicatorView(style: .medium)
        spinner.color = .white
        spinner.startAnimating()
        let reconnectingLabel = UILabel()
        reconnectingLabel.text = "Reconnecting…"
        reconnectingLabel.font = .preferredFont(forTextStyle: .headline)
        reconnectingLabel.textColor = .white
        reconnectingLabel.textAlignment = .center
        reconnecting.axis = .vertical
        reconnecting.alignment = .center
        reconnecting.spacing = 10
        reconnecting.addArrangedSubview(spinner)
        reconnecting.addArrangedSubview(reconnectingLabel)
        reconnecting.isHidden = true

        let content = UIStackView(arrangedSubviews: [failed, reconnecting])
        content.axis = .vertical
        content.alignment = .fill
        content.translatesAutoresizingMaskIntoConstraints = false
        card.contentView.addSubview(content)

        NSLayoutConstraint.activate([
            card.leadingAnchor.constraint(equalTo: leadingAnchor),
            card.trailingAnchor.constraint(equalTo: trailingAnchor),
            card.topAnchor.constraint(equalTo: topAnchor),
            card.bottomAnchor.constraint(equalTo: bottomAnchor),
            content.leadingAnchor.constraint(equalTo: card.contentView.leadingAnchor, constant: 24),
            content.trailingAnchor.constraint(equalTo: card.contentView.trailingAnchor, constant: -24),
            content.topAnchor.constraint(equalTo: card.contentView.topAnchor, constant: 20),
            content.bottomAnchor.constraint(equalTo: card.contentView.bottomAnchor, constant: -20),
        ])
    }

    private func copyDiagnostics() {
        UIPasteboard.general.string = Diagnostics.shared.text
        Diagnostics.shared.log("diagnostics copied (player)")
        copyButton.configuration = Self.copyConfiguration(copied: true)
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            self?.copyButton.configuration = PlayerStatusView.copyConfiguration(copied: false)
        }
    }

    private static func copyConfiguration(copied: Bool) -> UIButton.Configuration {
        var config = UIButton.Configuration.plain()
        config.title = copied ? "Copied" : "Copy diagnostics"
        config.image = UIImage(systemName: copied ? "checkmark" : "doc.on.doc")
        config.imagePadding = 6
        config.baseForegroundColor = .white
        return config
    }
}

/// Covers the player, in its content overlay (under the controls; touches pass through). For the UI
/// tests only it is an accessibility element, "player-video", whose value describes the player
/// (PlayerScreen.facts).
final class PlayerProbeView: UIView {
    var facts: (() -> String)?

    init() {
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        if PlayerScreen.describesItself {
            isAccessibilityElement = true
            accessibilityIdentifier = "player-video"
            accessibilityLabel = "Video"
        }
    }

    required init?(coder: NSCoder) {
        return nil
    }

    func fill(_ container: UIView) {
        translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(self)
        NSLayoutConstraint.activate([
            leadingAnchor.constraint(equalTo: container.leadingAnchor),
            trailingAnchor.constraint(equalTo: container.trailingAnchor),
            topAnchor.constraint(equalTo: container.topAnchor),
            bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
    }

    override var accessibilityValue: String? {
        get { facts?() }
        set {}
    }
}
