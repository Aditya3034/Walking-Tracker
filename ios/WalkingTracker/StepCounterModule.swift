import Foundation
import CoreMotion
import CoreLocation
import React

@objc(StepCounter)
class StepCounterModule: RCTEventEmitter, CLLocationManagerDelegate {

  // MARK: - Properties

  private let pedometer = CMPedometer()
  private let locationManager = CLLocationManager()
  private var pedometerStartDate: Date?

  private let defaults = UserDefaults.standard
  private static let STEPS_KEY = "wt_background_steps"
  private static let ROUTE_KEY  = "wt_background_route"

  private var backgroundRoute: [[String: Double]] = []
  private var listenerCount = 0

  // MARK: - Init

  override init() {
    super.init()
    locationManager.delegate = self
    locationManager.desiredAccuracy = kCLLocationAccuracyBest
    locationManager.distanceFilter = 3.0          // metres — matches Android
    locationManager.allowsBackgroundLocationUpdates = true
    locationManager.pausesLocationUpdatesAutomatically = false
    locationManager.activityType = .fitness
  }

  // MARK: - RCTEventEmitter

  override func supportedEvents() -> [String]! {
    return ["StepCounterUpdate"]
  }

  override static func requiresMainQueueSetup() -> Bool {
    return false
  }

  override func startObserving() {
    listenerCount += 1
  }

  override func stopObserving() {
    listenerCount -= 1
  }

  // MARK: - Step Counter

  @objc func startStepCounter() {
    guard CMPedometer.isStepCountingAvailable() else {
      NSLog("[StepCounter] Step counting unavailable on this device")
      return
    }
    pedometerStartDate = Date()
    pedometer.startUpdates(from: pedometerStartDate!) { [weak self] data, error in
      guard let self = self, let data = data, error == nil else { return }
      let steps = data.numberOfSteps.intValue
      // Persist so getBackgroundSteps() always returns current value
      self.defaults.set(steps, forKey: StepCounterModule.STEPS_KEY)
      if self.listenerCount > 0 {
        self.sendEvent(withName: "StepCounterUpdate", body: Double(steps))
      }
    }
    NSLog("[StepCounter] Pedometer started")
  }

  @objc func stopStepCounter() {
    pedometer.stopUpdates()
    pedometerStartDate = nil
    NSLog("[StepCounter] Pedometer stopped")
  }

  // MARK: - Background Service (Location)

  @objc func startBackgroundService(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    // Reset persisted data for this session
    backgroundRoute = []
    defaults.set(0,    forKey: StepCounterModule.STEPS_KEY)
    defaults.set("[]", forKey: StepCounterModule.ROUTE_KEY)

    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      let status = self.locationManager.authorizationStatus
      if status == .notDetermined {
        self.locationManager.requestAlwaysAuthorization()
      }
      self.locationManager.startUpdatingLocation()
      NSLog("[StepCounter] Background location started")
      resolve(true)
    }
  }

  @objc func stopBackgroundService(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async { [weak self] in
      self?.locationManager.stopUpdatingLocation()
      NSLog("[StepCounter] Background location stopped")
    }
    resolve(true)
  }

  // MARK: - Data Retrieval (called by JS on app restore)

  @objc func getBackgroundSteps(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let steps = defaults.integer(forKey: StepCounterModule.STEPS_KEY)
    resolve(steps)
  }

  @objc func getBackgroundRoute(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let json = defaults.string(forKey: StepCounterModule.ROUTE_KEY) ?? "[]"
    resolve(json)
  }

  // MARK: - CLLocationManagerDelegate

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let location = locations.last else { return }

    let point: [String: Double] = [
      "lat": location.coordinate.latitude,
      "lng": location.coordinate.longitude,
    ]
    backgroundRoute.append(point)

    // Persist immediately so data survives app termination
    if let data = try? JSONSerialization.data(withJSONObject: backgroundRoute, options: []),
       let json = String(data: data, encoding: .utf8) {
      defaults.set(json, forKey: StepCounterModule.ROUTE_KEY)
    }
  }

  func locationManager(_ manager: CLLocationManager,
                        didChangeAuthorization status: CLAuthorizationStatus) {
    NSLog("[StepCounter] Location auth status: \(status.rawValue)")
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    NSLog("[StepCounter] Location error: \(error.localizedDescription)")
  }
}
