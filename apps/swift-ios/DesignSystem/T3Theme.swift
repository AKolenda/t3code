import SwiftUI
import UIKit

enum T3Colors {
    // UIKit variants let recycled collection and terminal surfaces participate
    // in the same system appearance changes as SwiftUI views.
    static let uiBackground = adaptive(light: rgb(0xF2F2F7), dark: rgb(0x000000))
    static let uiTextPrimary = adaptive(light: rgb(0x262626), dark: rgb(0xF5F5F5))
    static let uiTextSecondary = adaptive(light: rgb(0x525252), dark: rgb(0xA3A3A3))
    static let uiSurfaceRaised = adaptive(light: rgb(0xF5F5F5), dark: rgb(0x1C1C1C))
    static let uiAccent = adaptive(light: rgb(0x007AFF), dark: rgb(0x0A84FF))

    static let background = Color(uiColor: uiBackground)
    static let sheet = color(light: rgb(0xF2F2F7, alpha: 0.98), dark: rgb(0x000000, alpha: 0.98))
    static let surface = color(light: rgb(0xFFFFFF), dark: rgb(0x171717))
    static let surfaceRaised = Color(uiColor: uiSurfaceRaised)
    static let input = color(light: rgb(0xFFFFFF), dark: rgb(0x141414))
    static let border = color(light: rgb(0x000000, alpha: 0.08), dark: rgb(0xFFFFFF, alpha: 0.06))
    static let inputBorder = color(
        light: rgb(0x000000, alpha: 0.10), dark: rgb(0xFFFFFF, alpha: 0.08))
    static let separator = color(
        light: rgb(0x000000, alpha: 0.04), dark: rgb(0xFFFFFF, alpha: 0.03))
    static let subtle = color(light: rgb(0x000000, alpha: 0.04), dark: rgb(0xFFFFFF, alpha: 0.04))
    static let subtleStrong = color(
        light: rgb(0x000000, alpha: 0.08), dark: rgb(0xFFFFFF, alpha: 0.08))
    static let shadow = color(light: rgb(0x000000, alpha: 0.18), dark: rgb(0x000000, alpha: 0.32))
    static let ledgerSurface = surface
    static let ledgerSelected = surfaceRaised

    static let textPrimary = Color(uiColor: uiTextPrimary)
    static let textSecondary = Color(uiColor: uiTextSecondary)
    static let textTertiary = color(light: rgb(0x737373), dark: rgb(0x8E8E93))
    static let placeholder = color(light: rgb(0xA3A3A3), dark: rgb(0x8E8E93))

    static let primaryAction = color(light: rgb(0x262626), dark: rgb(0xF5F5F5))
    static let primaryActionForeground = color(light: rgb(0xFFFFFF), dark: rgb(0x000000))
    static let accent = Color(uiColor: uiAccent)
    static let statusRunning = color(light: rgb(0x0284C7), dark: rgb(0x22D3EE))
    static let statusInput = color(light: rgb(0x4F46E5), dark: rgb(0xA5B4FC))
    static let success = color(light: rgb(0x16A34A), dark: rgb(0x30D158))
    static let warning = color(light: rgb(0xD97706), dark: rgb(0xFF9F0A))
    static let danger = color(light: rgb(0xDC2626), dark: rgb(0xFF453A))

    static let syntaxKeyword = color(light: rgb(0x7C3AED), dark: rgb(0xC78EFF))
    static let syntaxLiteral = color(light: rgb(0x2563EB), dark: rgb(0x8CC7FF))
    static let syntaxNumber = color(light: rgb(0xB45309), dark: rgb(0xEBAA6B))
    static let syntaxProperty = color(light: rgb(0x0F766E), dark: rgb(0x6BD1C2))

    private static func color(light: UIColor, dark: UIColor) -> Color {
        Color(uiColor: adaptive(light: light, dark: dark))
    }

    private static func adaptive(light: UIColor, dark: UIColor) -> UIColor {
        UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark : light
        }
    }

    private static func rgb(_ hex: UInt32, alpha: CGFloat = 1) -> UIColor {
        UIColor(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

/// The native client uses semantic fonts so every surface follows Dynamic Type.
/// Keep roles here instead of introducing one-off point sizes in feature views.
enum T3Typography {
    static let homeTitle = Font.system(.body, design: .default, weight: .semibold)
    static let homeMetadata = Font.system(.footnote, design: .default)

    static let navigationTitle = Font.system(.headline, design: .default, weight: .semibold)
    static let navigationMetadata = Font.system(.footnote, design: .default)
    static let status = Font.system(.footnote, design: .default, weight: .semibold)

    static let threadBody = Font.system(.body, design: .default)
    static let threadHeading1 = Font.system(.title2, design: .default, weight: .bold)
    static let threadHeading2 = Font.system(.title3, design: .default, weight: .bold)
    static let threadHeading3 = Font.system(.headline, design: .default, weight: .bold)
    static let threadHeading4 = Font.system(.body, design: .default, weight: .semibold)
    static let code = Font.system(.callout, design: .monospaced)
    static let tool = Font.system(.footnote, design: .monospaced)

    static let composer = Font.system(.body, design: .default)
    static let control = Font.system(.callout, design: .default, weight: .medium)
    static let supporting = Font.system(.footnote, design: .default)
    static let supportingStrong = Font.system(.footnote, design: .default, weight: .semibold)
    static let eyebrow = Font.system(.footnote, design: .default, weight: .bold)
}

enum T3Metrics {
    static let minimumTapTarget: CGFloat = 44
    static let maximumToolFailureMessageHeight: CGFloat = 144
    static let sidebarWidth: CGFloat = 320
    static let minimumSidebarWidth: CGFloat = 280
    static let maximumSidebarWidth: CGFloat = 380
    static let readingWidth: CGFloat = 760
}

/// Back-deploys the standard iOS 17 empty-state presentation to iOS 16.
struct T3ContentUnavailableView: View {
    private let label: AnyView
    private let description: AnyView
    private let actions: AnyView
    private let searchText: String?

    init(
        _ title: String,
        systemImage: String,
        description: Text? = nil
    ) {
        label = AnyView(Label(title, systemImage: systemImage))
        self.description = description.map { AnyView($0) } ?? AnyView(EmptyView())
        actions = AnyView(EmptyView())
        searchText = nil
    }

    init<LabelContent: View, DescriptionContent: View>(
        @ViewBuilder label: () -> LabelContent,
        @ViewBuilder description: () -> DescriptionContent
    ) {
        self.label = AnyView(label())
        self.description = AnyView(description())
        actions = AnyView(EmptyView())
        searchText = nil
    }

    init<LabelContent: View, DescriptionContent: View, ActionsContent: View>(
        @ViewBuilder label: () -> LabelContent,
        @ViewBuilder description: () -> DescriptionContent,
        @ViewBuilder actions: () -> ActionsContent
    ) {
        self.label = AnyView(label())
        self.description = AnyView(description())
        self.actions = AnyView(actions())
        searchText = nil
    }

    @ViewBuilder
    var body: some View {
        if #available(iOS 17.0, *) {
            if let searchText {
                ContentUnavailableView.search(text: searchText)
            } else {
                ContentUnavailableView {
                    label
                } description: {
                    description
                } actions: {
                    actions
                }
            }
        } else {
            fallback
        }
    }

    private var fallback: some View {
        VStack(spacing: 12) {
            label
                .font(.title3.weight(.semibold))
                .foregroundStyle(T3Colors.textPrimary)
            description
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textSecondary)
                .multilineTextAlignment(.center)
            actions
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
    }

    static func search(text: String) -> Self {
        Self(
            text.isEmpty ? "No results" : "No results for “\(text)”",
            systemImage: "magnifyingglass",
            searchText: text
        )
    }

    private init(
        _ title: String,
        systemImage: String,
        searchText: String
    ) {
        label = AnyView(Label(title, systemImage: systemImage))
        description = AnyView(EmptyView())
        actions = AnyView(EmptyView())
        self.searchText = searchText
    }
}

extension View {
    @ViewBuilder
    func t3PopoverCompactAdaptation() -> some View {
        if #available(iOS 16.4, *) {
            presentationCompactAdaptation(.popover)
        } else {
            self
        }
    }

    func t3NavigationChrome() -> some View {
        toolbarBackground(T3Colors.sheet, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
    }

    @ViewBuilder
    func t3PresentationBackground(_ color: Color) -> some View {
        if #available(iOS 16.4, *) {
            presentationBackground(color)
        } else {
            background(color)
        }
    }

    @ViewBuilder
    func t3ListSectionSpacing(_ spacing: CGFloat) -> some View {
        if #available(iOS 17.0, *) {
            listSectionSpacing(spacing)
        } else {
            self
        }
    }

    @ViewBuilder
    func t3ScrollBounceBasedOnSize() -> some View {
        if #available(iOS 16.4, *) {
            scrollBounceBehavior(.basedOnSize)
        } else {
            self
        }
    }

    /// iOS 16-compatible form of the two-value `onChange` API introduced in iOS 17.
    /// Uses the native modifier on iOS 17; the manual tracking below exists only for iOS 16.
    @ViewBuilder
    func t3OnChange<Value: Equatable>(
        of value: Value,
        initial: Bool = false,
        perform action: @escaping (_ oldValue: Value, _ newValue: Value) -> Void
    ) -> some View {
        if #available(iOS 17.0, *) {
            onChange(of: value, initial: initial, action)
        } else {
            modifier(T3OnChangeModifier(value: value, initial: initial, action: action))
        }
    }

    func t3OnChange<Value: Equatable>(
        of value: Value,
        initial: Bool = false,
        perform action: @escaping (_ newValue: Value) -> Void
    ) -> some View {
        t3OnChange(of: value, initial: initial) { _, newValue in action(newValue) }
    }

    func t3OnChange<Value: Equatable>(
        of value: Value,
        initial: Bool = false,
        perform action: @escaping () -> Void
    ) -> some View {
        t3OnChange(of: value, initial: initial) { _, _ in action() }
    }
}

private struct T3OnChangeModifier<Value: Equatable>: ViewModifier {
    let value: Value
    let initial: Bool
    let action: (_ oldValue: Value, _ newValue: Value) -> Void

    @State private var previous: Value
    @State private var didAppear = false

    init(
        value: Value,
        initial: Bool,
        action: @escaping (_ oldValue: Value, _ newValue: Value) -> Void
    ) {
        self.value = value
        self.initial = initial
        self.action = action
        _previous = State(initialValue: value)
    }

    func body(content: Content) -> some View {
        content
            .onAppear {
                guard !didAppear else { return }
                didAppear = true
                previous = value
                if initial { action(value, value) }
            }
            .onChange(of: value) { newValue in
                let oldValue = previous
                previous = newValue
                action(oldValue, newValue)
            }
    }
}
