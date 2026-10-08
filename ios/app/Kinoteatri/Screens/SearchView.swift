// Search: the field (always shown), results as the person types, a Movies/Series filter, and a
// poster grid; a result opens its title. Before a search: recent searches and a line on what to do.
// The search field lets go of the keyboard once a search is sent and when a title opens (else it
// can come back over the player).

import SwiftUI

struct SearchView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var library: LibraryStore
    @ObservedObject var store: SearchStore
    @State private var path = NavigationPath()
    @FocusState private var searchFocused: Bool

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                content
                    .padding(.top, 8)
                    .padding(.bottom, 32)
            }
            .scrollDismissesKeyboard(.immediately)
            .houseBackground()
            .navigationTitle(L.search)
            .navigationDestination(for: Title.self) { TitleDetailView(title: $0) }
            .searchable(text: $store.query, placement: .navigationBarDrawer(displayMode: .always), prompt: L.searchPrompt)
            .searchFocus($searchFocused)
            .autocorrectionDisabled()
            .onChange(of: store.query) { _ in store.queryChanged() }
            .onSubmit(of: .search) {
                endSearchEditing()
                store.submit()
            }
            .onDisappear { endSearchEditing() }
            .onChange(of: app.focusSearch) { focus in
                guard focus else { return }
                app.focusSearch = false
                path = NavigationPath()
                searchFocused = true
            }
        }
        .miniPlayerInset()
    }

    @ViewBuilder private var content: some View {
        switch store.phase {
        case .idle:
            idle
        case .loading where store.results.isEmpty:
            VStack(alignment: .leading, spacing: 18) {
                filterBar
                LazyVGrid(columns: Self.columns, alignment: .leading, spacing: 22) {
                    ForEach(0..<9, id: \.self) { _ in SkeletonPosterCard() }
                }
                .padding(.horizontal, Theme.gutter)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(L.starting)
        case .failed(let message) where store.results.isEmpty:
            ErrorCard(title: L.searchFailed, message: message) { store.retry() }
                .padding(.horizontal, Theme.gutter)
        default:
            results
        }
    }

    // MARK: Before a search

    private var idle: some View {
        VStack(alignment: .leading, spacing: 26) {
            if !library.recentSearches.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text(L.recentSearches)
                            .eyebrowFont()
                        Spacer()
                        Button(L.clear) { library.clearSearches() }
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Theme.bulb)
                    }
                    FlowLayout(spacing: 8) {
                        ForEach(library.recentSearches, id: \.self) { query in
                            Button {
                                Haptics.select()
                                endSearchEditing()
                                store.search(query)
                            } label: {
                                Chip(text: query, systemImage: "clock.arrow.circlepath")
                            }
                            .buttonStyle(PressableStyle())
                            .contextMenu {
                                Button(role: .destructive) {
                                    library.removeSearch(query)
                                } label: {
                                    Label(L.remove, systemImage: "trash")
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, Theme.gutter)
            }
            EmptyState(systemImage: "film.stack", title: L.searchIdleTitle, message: L.searchIdleBody)
                .padding(.top, library.recentSearches.isEmpty ? 40 : 0)
        }
    }

    // MARK: Results

    private static let columns = [GridItem(.adaptive(minimum: 104, maximum: 190), spacing: 14, alignment: .top)]

    private var filterBar: some View {
        Picker(L.filterAll, selection: $store.filter) {
            ForEach(KindFilter.allCases) { filter in
                Text(filter.label).tag(filter)
            }
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, Theme.gutter)
        .onChange(of: store.filter) { _ in Haptics.select() }
    }

    private var results: some View {
        VStack(alignment: .leading, spacing: 18) {
            filterBar
            if store.shown.isEmpty {
                if store.results.isEmpty, let searched = store.searched {
                    EmptyState(systemImage: "magnifyingglass", title: L.nothingFound(searched), message: L.nothingFoundBody)
                } else {
                    EmptyState(systemImage: "line.3.horizontal.decrease.circle", title: L.nothingOfKind(store.filter.label), message: L.nothingFoundBody)
                }
            } else {
                LazyVGrid(columns: Self.columns, alignment: .leading, spacing: 22) {
                    ForEach(Array(store.shown.enumerated()), id: \.offset) { index, title in
                        Button {
                            open(title)
                        } label: {
                            PosterCard(title: title, progress: progress(of: title))
                        }
                        .buttonStyle(PressableStyle())
                        .accessibilityIdentifier("result-\(index)")
                    }
                }
                .padding(.horizontal, Theme.gutter)
                // A newer search on its way: the old results stay, dimmed.
                .opacity(store.phase == .loading ? 0.45 : 1)
                .animation(.easeOut(duration: 0.2), value: store.phase)
            }
        }
    }

    /// How far a result was watched, if it was.
    private func progress(of title: Title) -> Double? {
        guard let entry = library.entry(for: title.id), !entry.isFinished, entry.position >= 5 else { return nil }
        return entry.progress
    }

    private func open(_ title: Title) {
        endSearchEditing()
        store.opened()
        path.append(title)
    }

    /// The search field lets go of the keyboard (SwiftUI's focus, iOS 18+, and UIKit's first
    /// responder), keeping its text.
    private func endSearchEditing() {
        searchFocused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}

extension View {
    /// `searchFocused` where the system has it (iOS 18).
    @ViewBuilder func searchFocus(_ focused: FocusState<Bool>.Binding) -> some View {
        if #available(iOS 18.0, *) {
            searchFocused(focused)
        } else {
            self
        }
    }
}

/// Lays its children out in rows, wrapping like words (recent searches).
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var widest: CGFloat = 0
        for view in subviews {
            let size = fitted(view, width: width)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            widest = max(widest, x - spacing)
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: proposal.width ?? widest, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for view in subviews {
            let size = fitted(view, width: bounds.width)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }

    /// Its own size, no wider than a row.
    private func fitted(_ view: LayoutSubview, width: CGFloat) -> CGSize {
        let ideal = view.sizeThatFits(.unspecified)
        guard ideal.width > width else { return ideal }
        return view.sizeThatFits(ProposedViewSize(width: width, height: nil))
    }
}
