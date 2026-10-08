// Search as the person types: a moment after the last key (and at once on Search), the core is
// asked; an answer for older text is dropped. Results can be narrowed to movies or series. Searches
// sent with the keyboard's Search key (and ones a result was opened from) become recent searches.

import Foundation

enum KindFilter: String, CaseIterable, Identifiable {
    case all
    case movies
    case series

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: return L.filterAll
        case .movies: return L.filterMovies
        case .series: return L.filterSeries
        }
    }

    func apply(_ titles: [Title]) -> [Title] {
        switch self {
        case .all: return titles
        case .movies: return titles.filter { !$0.isSeries }
        case .series: return titles.filter(\.isSeries)
        }
    }
}

@MainActor
final class SearchStore: ObservableObject {
    enum Phase: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    /// Typing stops this long before the core is asked.
    static let pause: UInt64 = 450_000_000
    /// Shorter text isn't searched as it's typed.
    static let minimumLength = 2

    @Published var query = ""
    @Published var filter: KindFilter = .all
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var results: [Title] = []
    /// The text the results are for.
    @Published private(set) var searched: String?

    private let library: LibraryStore
    private var task: Task<Void, Never>?

    init(library: LibraryStore) {
        self.library = library
    }

    /// The results through the filter.
    var shown: [Title] {
        filter.apply(results)
    }

    private var text: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The text changed: search a moment later, or clear when it's empty.
    func queryChanged() {
        task?.cancel()
        let text = self.text
        if text.isEmpty {
            results = []
            searched = nil
            phase = .idle
            return
        }
        guard text.count >= Self.minimumLength, text != searched else {
            // A search that was on its way for other text is off: show what's there.
            if phase == .loading {
                phase = searched == nil ? .idle : .loaded
            }
            return
        }
        task = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.pause)
            guard !Task.isCancelled else { return }
            await self?.run(text, remember: false)
        }
    }

    /// The keyboard's Search key.
    func submit() {
        task?.cancel()
        let text = self.text
        guard !text.isEmpty else { return }
        if text == searched, phase == .loaded {
            library.searched(text)
            return
        }
        task = Task { [weak self] in
            await self?.run(text, remember: true)
        }
    }

    /// A recent search tapped.
    func search(_ text: String) {
        query = text
        submit()
    }

    func retry() {
        searched = nil
        submit()
    }

    /// A result was opened: its search is worth remembering.
    func opened() {
        if let searched {
            library.searched(searched)
        }
    }

    private func run(_ text: String, remember: Bool) async {
        phase = .loading
        do {
            let found = try await KinoCore.shared.search(text)
            // Older text than what's in the field now: a newer search is coming.
            guard !Task.isCancelled, text == self.text else { return }
            results = found
            searched = text
            phase = .loaded
            if remember {
                library.searched(text)
            }
        } catch {
            guard !Task.isCancelled, text == self.text else { return }
            phase = .failed(describe(error))
        }
    }
}
