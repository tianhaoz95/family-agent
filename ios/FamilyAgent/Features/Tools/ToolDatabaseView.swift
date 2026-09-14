import SwiftUI

private let pageSize = 50

/// Read-only browser for a "server"-kind tool's private SQLite database, or a
/// static tool's saved `/__state` blobs — the mobile mirror of desktop's
/// `#db-inspector`. Everything here is display-only: the harness only ever
/// opens the connection read-only, and the one write-shaped affordance (the
/// SQL box) is server-side-restricted to SELECT/WITH/EXPLAIN/PRAGMA anyway —
/// this view doesn't need to (and doesn't) enforce that itself.
///
/// Pushed (never a sheet) like `WikiPageEditorView`/`ArtifactViewerView`, so
/// it relies on `NavigationStack`'s own back chevron and sets
/// `model.toolDbOpen` so `MainShell` hides its floating menu button while
/// that chevron is showing in the same top-left corner.
struct ToolDatabaseView: View {
    let tool: Tool
    @Environment(AppModel.self) private var model

    @State private var overview: ToolDbOverview?
    @State private var selectedTable: String?
    @State private var selectedStateKey: String?
    @State private var stateValueText: String?
    @State private var rowPage: ToolDbRowPage?
    @State private var queryResult: ToolDbQueryResult?
    @State private var orderBy: String?
    @State private var dir = "asc"
    @State private var offset = 0
    @State private var sql = ""
    @State private var loading = true
    @State private var errorText: String?

    var body: some View {
        Group {
            if let error = errorText, overview == nil {
                VStack { Spacer(); Text(error).appBody().foregroundStyle(Theme.danger).padding(); Spacer() }
            } else if let ov = overview {
                if ov.kind != "server" {
                    staticBody(ov)
                } else if !ov.exists || ov.tables.isEmpty {
                    VStack {
                        Spacer()
                        EmptyState(
                            text: !ov.exists
                                ? "This tool starts storing information the first time it's used in Chat or opened."
                                : "Once the tool records something, it'll show up here.",
                            systemImage: "cylinder.split.1x2"
                        )
                        Spacer()
                    }
                } else {
                    serverBody(ov)
                }
            } else {
                VStack { Spacer(); ProgressView(); Spacer() }
            }
        }
        .navigationTitle(tool.name + (overview?.kind == "static" ? " \u{2014} saved data" : " \u{2014} database"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let bytes = overview?.sizeBytes {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text(tool.name).font(.inter(16, .bold)).lineLimit(1)
                        Text(fmtBytes(bytes)).appLabelSmall().foregroundStyle(Theme.textMuted)
                    }
                }
            }
        }
        .onAppear { model.toolDbOpen = true }
        .onDisappear { model.toolDbOpen = false }
        .task { await loadOverview() }
    }

    // MARK: - Loading

    private func loadOverview() async {
        loading = true
        do {
            let ov = try await model.loadToolDb(tool.id)
            overview = ov
            if ov.kind == "server" {
                if let first = ov.tables.first { await selectTable(first.name) } else { loading = false }
            } else {
                if let first = ov.stateEntries.first { await selectStateKey(first.key) } else { loading = false }
            }
        } catch {
            errorText = error.localizedDescription
            loading = false
        }
    }

    private func selectTable(_ name: String) async {
        selectedTable = name
        selectedStateKey = nil
        orderBy = nil
        dir = "asc"
        offset = 0
        sql = ""
        await loadPage()
    }

    private func loadPage() async {
        guard let table = selectedTable else { return }
        loading = true
        errorText = nil
        do {
            rowPage = try await model.loadToolDbRows(tool.id, table: table, limit: pageSize, offset: offset, orderBy: orderBy, dir: orderBy != nil ? dir : nil)
            queryResult = nil
        } catch {
            errorText = error.localizedDescription
            rowPage = nil
        }
        loading = false
    }

    private func selectStateKey(_ key: String) async {
        selectedStateKey = key
        selectedTable = nil
        loading = true
        errorText = nil
        do {
            let value = try await model.loadToolDbState(tool.id, key: key)
            stateValueText = value.map { $0.prettyJSON } ?? "null"
        } catch {
            errorText = error.localizedDescription
        }
        loading = false
    }

    private func runSql() async {
        let q = sql.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        loading = true
        errorText = nil
        selectedTable = nil
        offset = 0
        do {
            queryResult = try await model.runToolDbQuery(tool.id, sql: q)
            rowPage = nil
        } catch {
            errorText = error.localizedDescription
        }
        loading = false
    }

    // MARK: - Static (non-server) tool: saved /__state blobs

    @ViewBuilder
    private func staticBody(_ ov: ToolDbOverview) -> some View {
        if ov.stateEntries.isEmpty {
            VStack { Spacer(); EmptyState(text: "This tool hasn't stored anything so far.", systemImage: "cylinder.split.1x2"); Spacer() }
        } else {
            HStack(spacing: 0) {
                List(ov.stateEntries, id: \.key) { e in
                    Button {
                        Task { await selectStateKey(e.key) }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(e.key == "__ls" ? "browser storage" : e.key).appBody().lineLimit(1)
                            Text(fmtBytes(e.bytes)).appLabelSmall().foregroundStyle(Theme.textMuted)
                        }
                    }
                    .listRowBackground(e.key == selectedStateKey ? Theme.accent.opacity(0.12) : Color.clear)
                }
                .listStyle(.plain)
                .frame(width: 160)
                Divider()
                ScrollView([.vertical, .horizontal]) {
                    if loading && stateValueText == nil {
                        ProgressView().padding()
                    } else if let error = errorText {
                        Text(error).foregroundStyle(Theme.danger).padding()
                    } else if let text = stateValueText {
                        Text(text).font(.system(size: 12, design: .monospaced)).padding()
                    }
                }
            }
        }
    }

    // MARK: - Server tool: real SQLite tables

    @ViewBuilder
    private func serverBody(_ ov: ToolDbOverview) -> some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(ov.tables, id: \.name) { t in
                        Button {
                            Task { await selectTable(t.name) }
                        } label: {
                            Text(t.rowCount != nil ? "\(t.name) (\(t.rowCount!))" : t.name)
                                .font(.inter(13, .semibold))
                        }
                        .buttonStyle(.chip(selected: t.name == selectedTable))
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
            }
            Divider()

            HStack(spacing: 8) {
                TextField("SELECT \u{2026} (read-only)", text: $sql)
                    .textFieldStyle(.app)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onSubmit { Task { await runSql() } }
                Button("Run") { Task { await runSql() } }
                    .buttonStyle(.primary)
                    .disabled(sql.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(12)

            if let error = errorText {
                Text(error).appBodySmall().foregroundStyle(Theme.danger).padding(.horizontal, 12)
            }

            if loading && rowPage == nil && queryResult == nil {
                Spacer()
                ProgressView()
                Spacer()
            } else if let q = queryResult {
                Text(q.truncated
                     ? "\(q.rowCount) rows (truncated \u{2014} refine the query to see more)"
                     : "\(q.rowCount) row\(q.rowCount == 1 ? "" : "s")")
                    .appLabelSmall().foregroundStyle(Theme.textMuted)
                    .padding(.horizontal, 12).padding(.bottom, 4)
                DataGrid(columns: q.columns.map { ToolDbColumn(name: $0, type: "", pk: false, notNull: false) }, rows: q.rows, orderBy: nil, dir: "asc", onSort: nil)
                Spacer()
            } else if let p = rowPage {
                DataGrid(columns: p.columns, rows: p.rows, orderBy: orderBy, dir: dir, onSort: { col in
                    if orderBy == col { dir = dir == "asc" ? "desc" : "asc" } else { orderBy = col; dir = "asc" }
                    offset = 0
                    Task { await loadPage() }
                })
                Spacer(minLength: 0)
                Divider()
                HStack {
                    Button("\u{2190} Prev") { offset = max(0, offset - pageSize); Task { await loadPage() } }
                        .disabled(p.offset == 0)
                    Spacer()
                    let from = p.total == 0 ? 0 : p.offset + 1
                    let to = min(p.offset + p.limit, p.total)
                    Text("\(from)\u{2013}\(to) of \(p.total)").appLabelSmall().foregroundStyle(Theme.textMuted)
                    Spacer()
                    Button("Next \u{2192}") { offset += pageSize; Task { await loadPage() } }
                        .disabled(to >= p.total)
                }
                .padding(12)
            } else {
                Spacer()
            }
        }
    }
}

private struct DataGrid: View {
    let columns: [ToolDbColumn]
    let rows: [[String: JSONValue]]
    let orderBy: String?
    let dir: String
    let onSort: ((String) -> Void)?
    private let cellWidth: CGFloat = 130

    var body: some View {
        if rows.isEmpty {
            Text("No rows.").appBody().foregroundStyle(Theme.textMuted).padding()
        } else {
            ScrollView(.horizontal, showsIndicators: true) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 0) {
                        ForEach(columns, id: \.name) { col in
                            Button {
                                onSort?(col.name)
                            } label: {
                                HStack(spacing: 2) {
                                    Text(col.name + (col.pk ? " \u{1F511}" : "")).appLabelSmall().lineLimit(1)
                                    if orderBy == col.name { Text(dir == "asc" ? "\u{25B2}" : "\u{25BC}").appLabelSmall() }
                                }
                                .frame(width: cellWidth, alignment: .leading)
                                .padding(.horizontal, 8).padding(.vertical, 8)
                            }
                            .buttonStyle(.plain)
                            .disabled(onSort == nil)
                        }
                    }
                    .background(Theme.surfaceSunk)
                    Divider()
                    ScrollView(.vertical) {
                        VStack(spacing: 0) {
                            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                                HStack(spacing: 0) {
                                    ForEach(columns, id: \.name) { col in
                                        let v = row[col.name]
                                        Text(v.map(displayString) ?? "NULL")
                                            .appBodySmall()
                                            .foregroundStyle((v == nil || v == .null) ? Theme.textMuted : Theme.text)
                                            .lineLimit(1)
                                            .frame(width: cellWidth, alignment: .leading)
                                            .padding(.horizontal, 8).padding(.vertical, 6)
                                    }
                                }
                                Divider()
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Mirrors desktop's `renderDbGrid` cell rendering: null, a blob marker
/// object (`{ __blob: true, bytes, preview }`), or a plain value.
private func displayString(_ v: JSONValue) -> String {
    switch v {
    case .null: return "NULL"
    case .object(let o):
        if case .bool(true)? = o["__blob"], case .number(let bytes)? = o["bytes"] {
            return "\u{2039}blob \(Int(bytes)) B\u{203A}"
        }
        return v.prettyJSON
    case .string(let s): return s
    case .bool(let b): return b ? "true" : "false"
    case .number(let n): return n == n.rounded() ? String(Int(n)) : String(n)
    case .array: return v.prettyJSON
    }
}

private func fmtBytes(_ n: Int) -> String {
    if n < 1024 { return "\(n) B" }
    if n < 1024 * 1024 { return String(format: "%.1f KB", Double(n) / 1024) }
    return String(format: "%.1f MB", Double(n) / (1024 * 1024))
}

// MARK: - Selectable "chip" button style for the table picker

private struct ChipButtonStyle: ButtonStyle {
    let selected: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(selected ? Theme.accent.opacity(0.16) : Theme.surfaceSunk, in: Capsule())
            .foregroundStyle(selected ? Theme.accentInk : Theme.text)
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}
private extension ButtonStyle where Self == ChipButtonStyle {
    static func chip(selected: Bool) -> ChipButtonStyle { ChipButtonStyle(selected: selected) }
}
