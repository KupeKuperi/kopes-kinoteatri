// Posters from MovieBox's image CDN: fetched once, scaled down to the size they're shown at (posters
// come at ~1000 px; a grid shows them at ~330), kept in memory, and handed to SwiftUI, to Now Playing
// (artwork) and to CarPlay (list images) alike. URLSession's cache keeps the downloads on disk.

import ImageIO
import SwiftUI
import UIKit

final class ImageCache: @unchecked Sendable {
    static let shared = ImageCache()

    private let memory = NSCache<NSString, UIImage>()
    private let session: URLSession

    init() {
        memory.totalCostLimit = 60 * 1024 * 1024
        let config = URLSessionConfiguration.default
        config.urlCache = URLCache(memoryCapacity: 8 * 1024 * 1024, diskCapacity: 150 * 1024 * 1024)
        config.requestCachePolicy = .returnCacheDataElseLoad
        config.timeoutIntervalForRequest = 20
        session = URLSession(configuration: config)
    }

    /// The image already in memory at that size, if any (no network).
    func cached(_ address: String?, maxPixels: CGFloat) -> UIImage? {
        guard let address else { return nil }
        return memory.object(forKey: Self.key(address, maxPixels))
    }

    /// The image at `address`, at most `maxPixels` on its longer side; nil when it can't be had.
    func image(_ address: String?, maxPixels: CGFloat) async -> UIImage? {
        guard let address, let url = URL(string: address), url.scheme?.hasPrefix("http") == true else { return nil }
        let key = Self.key(address, maxPixels)
        if let hit = memory.object(forKey: key) {
            return hit
        }
        guard let answer = try? await session.data(from: url) else { return nil }
        let (data, response) = answer
        guard (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? true,
              let image = Self.downsample(data, maxPixels: maxPixels)
        else { return nil }
        let cost = Int(image.size.width * image.size.height * image.scale * image.scale * 4)
        memory.setObject(image, forKey: key, cost: cost)
        return image
    }

    private static func key(_ address: String, _ maxPixels: CGFloat) -> NSString {
        "\(Int(maxPixels))@\(address)" as NSString
    }

    /// Decodes straight to the smaller size (ImageIO), never the full poster.
    static func downsample(_ data: Data, maxPixels: CGFloat) -> UIImage? {
        let sourceOptions: [CFString: Any] = [kCGImageSourceShouldCache: false]
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions as CFDictionary) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(32, Int(maxPixels)),
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}

/// An image from a URL that fills its frame (the parent sizes and clips it): a shimmer while it
/// loads, `fallback` when there's none.
struct RemoteImage<Fallback: View>: View {
    let url: String?
    /// Longest side in pixels to decode at.
    var maxPixels: CGFloat = 480
    @ViewBuilder var fallback: () -> Fallback

    @State private var image: UIImage?
    @State private var loading = true

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            } else if loading, url != nil {
                SkeletonBlock(cornerRadius: 0)
            } else {
                fallback()
            }
        }
        .task(id: url) {
            if let hit = ImageCache.shared.cached(url, maxPixels: maxPixels) {
                image = hit
                loading = false
                return
            }
            image = nil
            loading = true
            let loaded = await ImageCache.shared.image(url, maxPixels: maxPixels)
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.25)) {
                image = loaded
                loading = false
            }
        }
    }
}

/// A poster: 2:3, rounded, with a film glyph when there's no picture.
struct PosterArt: View {
    let url: String?
    var title: String = ""
    var cornerRadius: CGFloat = Theme.posterRadius
    var maxPixels: CGFloat = 480

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        Color.clear
            .aspectRatio(Theme.posterAspect, contentMode: .fit)
            .overlay {
                RemoteImage(url: url, maxPixels: maxPixels) {
                    PosterFallback(title: title)
                }
            }
            .clipShape(shape)
            .overlay(shape.strokeBorder(Color.white.opacity(0.07)))
            .accessibilityHidden(true)
    }
}

/// No poster: the velvet, a glyph and the title's initials, so a grid of them still reads.
private struct PosterFallback: View {
    let title: String

    var body: some View {
        ZStack {
            LinearGradient(colors: [Theme.curtain, Theme.velvet], startPoint: .top, endPoint: .bottom)
            VStack(spacing: 6) {
                Image(systemName: "film")
                    .font(.title2)
                    .foregroundStyle(Theme.dim)
                if !initials.isEmpty {
                    Text(initials)
                        .font(.caption.weight(.heavy))
                        .fontWidth(.condensed)
                        .foregroundStyle(Theme.usher)
                }
            }
        }
    }

    private var initials: String {
        title.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    }
}
