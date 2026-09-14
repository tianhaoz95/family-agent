plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "app.familyagent.android.wear"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.familyagent.android.wear"
        // Wear OS 3+ (API 30) — the oldest still-current generation of watches;
        // Wear OS 2 devices (API < 30) are a shrinking, mostly-unsupported tail.
        minSdk = 30
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

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

    buildFeatures {
        compose = true
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")

    // Wear-specific Compose (round/square-aware layout, curved text, the
    // scaling list, swipe-to-dismiss nav) — not the phone's Material3.
    implementation("androidx.wear.compose:compose-material:1.4.1")
    implementation("androidx.wear.compose:compose-foundation:1.4.1")
    implementation("androidx.wear.compose:compose-navigation:1.4.1")
    // RemoteInputIntentHelper — the system text/voice/handwriting input sheet
    // (see WearInput.kt for why this, not a Compose TextField, is "the
    // proper way the OS lets the user enter input" on Wear).
    implementation("androidx.wear:wear-input:1.1.0")
    // Wearable Data Layer (MessageClient/ChannelClient/DataClient) — the
    // phone<->watch relay. This is the same Play Services artifact the phone
    // side (app/build.gradle.kts) also takes on, just for the watch end of
    // the same conversation.
    implementation("com.google.android.gms:play-services-wearable:19.0.0")

    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // Task<T>.await() for the Wearable Data Layer's Play Services Tasks API.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.8.1")

    debugImplementation("androidx.compose.ui:ui-tooling")
}
