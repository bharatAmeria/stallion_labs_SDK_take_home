require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "react-native-bitnet"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => "14.0" }
  s.source       = { :git => package["repository"]["url"], :tag => "#{s.version}" }

  s.source_files = "ios/**/*.{h,m,mm,swift}", "cpp/**/*.{h,cpp}"

  # BitNet.cpp will be fetched via a CMake script invoked from the podspec
  # For iOS: arm64 + Objective-C/Swift bridge (Stage 1b)
  s.pod_target_xcconfig = {
    "CLANG_CXX_LANGUAGE_STANDARD"   => "c++17",
    "OTHER_CPLUSPLUSFLAGS"          => "-DGGML_USE_ACCELERATE=1",
    "OTHER_LDFLAGS"                 => "-framework Accelerate"
  }

  s.dependency "React-Core"
  if ENV["RCT_NEW_ARCH_ENABLED"] == "1"
    s.dependency "React-RCTFabric"
    s.dependency "React-Codegen"
    s.dependency "RCT-Folly"
    s.dependency "RCTRequired"
    s.dependency "RCTTypeSafety"
    s.dependency "ReactCommon/turbomodule/core"
  end
end
