plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The UI is the same web app the PC version serves; it is copied into the APK's assets.
val copyWebUi by tasks.registering(Sync::class) {
    from(rootProject.file("../openthermcam/web"))
    into(layout.buildDirectory.dir("generated/webui/web"))
}

android {
    namespace = "io.github.desertspider.openthermcam"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.desertspider.openthermcam"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/webui"))

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

tasks.named("preBuild") { dependsOn(copyWebUi) }

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.webkit:webkit:1.12.1")
}
