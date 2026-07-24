import Orion
import ObjectiveC.runtime
import UIKit

var statefulPlayer: StatefulPlayerImplementation?
var backgroundViewModel: SPTNowPlayingBackgroundViewModel?
var scrollDataSource: NowPlayingScrollDataSourceImplementation?

var nowPlayingScrollViewController: NowPlayingScrollViewController?
var npvScrollViewController: NPVScrollViewController?

class LegacyNowPlayingPlatformSwiftServiceImplementationHook: ClassHook<NSObject> {
    typealias Group = IOS14PremiumPatchingGroup
    static let targetName = "NowPlaying_PlatformImpl.NowPlayingPlatformSwiftServiceImplementation"
    
    func provideStatefulPlayer() -> StatefulPlayerImplementation {
        statefulPlayer = orig.provideStatefulPlayer()
        return statefulPlayer!
    }
}

class NowPlayingPlatformSwiftServiceImplementationHook: ClassHook<NSObject> {
    typealias Group = StatefulPlayerCaptureGroup
    static let targetName = "NowPlaying_PlatformImpl.NowPlayingPlatformSwiftServiceImplementation"
    
    func provideStatefulPlayerWithFeatureIdentifier(_ identifier: NSString) -> StatefulPlayerImplementation {
        statefulPlayer = orig.provideStatefulPlayerWithFeatureIdentifier(identifier)
        writeDebugLog("[LyricsEditor] Stateful Player captured: \(NSStringFromClass(type(of: statefulPlayer! as AnyObject)))")
        return statefulPlayer!
    }
}

private var statefulPlayerCaptureGroupActivated = false

func activateStatefulPlayerCapture() {
    guard !statefulPlayerCaptureGroupActivated else { return }

    let className = "NowPlaying_PlatformImpl.NowPlayingPlatformSwiftServiceImplementation"
    let selector = Selector(("provideStatefulPlayerWithFeatureIdentifier:"))
    guard let serviceClass = NSClassFromString(className),
          let method = class_getInstanceMethod(serviceClass, selector),
          method_getNumberOfArguments(method) == 3,
          methodReturnType(method) == "@",
          methodArgumentType(method, index: 2) == "@" else {
        writeDebugLog("[LyricsEditor] skipped Stateful Player capture: class/selector mismatch")
        return
    }

    statefulPlayerCaptureGroupActivated = true
    StatefulPlayerCaptureGroup().activate()
    writeDebugLog("[LyricsEditor] Stateful Player capture activated")
}

private func methodReturnType(_ method: Method) -> String {
    let raw = method_copyReturnType(method)
    defer { free(raw) }
    return String(cString: raw)
}

private func methodArgumentType(_ method: Method, index: UInt32) -> String {
    guard let raw = method_copyArgumentType(method, index) else { return "" }
    defer { free(raw) }
    return String(cString: raw)
}

class NowPlayingScrollPrivateServiceImplementationHook: ClassHook<NSObject> {
    typealias Group = BaseLyricsGroup
    static let targetName = "NowPlaying_ScrollImpl.NowPlayingScrollPrivateServiceImplementation"
    
    func provideScrollViewControllerWithDependencies(_ dependencies: NSObject) -> UIViewController {
        let scrollViewController = orig.provideScrollViewControllerWithDependencies(dependencies)
        
        if NSStringFromClass(type(of: scrollViewController)) ~= "NowPlayingScrollViewController" {
            nowPlayingScrollViewController = Dynamic.convert(
                scrollViewController,
                to: NowPlayingScrollViewController.self
            )
        }
        else {
            scrollDataSource = Ivars<NowPlayingScrollDataSourceImplementation>(target)
                .$__lazy_storage_$_scrollDataSource
            npvScrollViewController = Dynamic.convert(
                scrollViewController,
                to: NPVScrollViewController.self
            )
        }
        
        backgroundViewModel = Ivars<SPTNowPlayingBackgroundViewModel>(dependencies)
            .backgroundViewModel
        
        return scrollViewController
    }
}
