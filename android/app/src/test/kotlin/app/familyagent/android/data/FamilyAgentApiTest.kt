package app.familyagent.android.data

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class FamilyAgentApiTest {
    private lateinit var server: MockWebServer
    private lateinit var api: FamilyAgentApi

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        api = FamilyAgentApi(server.url("/").toString().trimEnd('/'))
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `health parses model and status`() = runBlocking {
        server.enqueue(
            MockResponse().setBody("""{"ok":true,"model":"qwen2.5:3b","ollamaBaseUrl":"http://127.0.0.1:11434"}""")
        )
        val health = api.health()
        assertTrue(health.ok)
        assertEquals("qwen2.5:3b", health.model)
    }

    @Test
    fun `listTasks parses task array`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"tasks":[{"id":"ABCD1234","title":"Buy stamps","notes":null,"dueDate":"2026-09-10","status":"open","createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}]}"""
            )
        )
        val tasks = api.listTasks()
        assertEquals(1, tasks.size)
        assertEquals("Buy stamps", tasks[0].title)
        assertEquals("open", tasks[0].status)
    }

    @Test
    fun `createTask sends the right body`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"task":{"id":"XYZ12345","title":"Renew passport","notes":null,"dueDate":null,"status":"open","createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}}"""
            )
        )
        val task = api.createTask("Renew passport", null)
        assertEquals("Renew passport", task.title)

        val recorded = server.takeRequest()
        assertEquals("POST", recorded.method)
        assertEquals("/tasks", recorded.path)
        assertTrue(recorded.body.readUtf8().contains("Renew passport"))
    }

    @Test
    fun `chat omits images when none attached, includes them when present`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"reply":"hi"}"""))
        api.chat("hello")
        val plain = server.takeRequest().body.readUtf8()
        assertEquals("""{"message":"hello"}""", plain)

        server.enqueue(MockResponse().setBody("""{"reply":"a cat"}"""))
        api.chat("what is this?", listOf("data:image/jpeg;base64,AAAA"))
        val withImg = server.takeRequest().body.readUtf8()
        assertTrue(withImg.contains(""""images":["data:image/jpeg;base64,AAAA"]"""))
    }

    @Test
    fun `non-2xx response throws ApiException with useful message`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"boom"}"""))
        try {
            api.listTasks()
            org.junit.Assert.fail("expected ApiException")
        } catch (e: ApiException) {
            assertTrue(e.message!!.contains("500"))
        }
    }

    @Test
    fun `login parses the token and user, and sends credentials`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"token":"sess-123","user":{"id":"U1","username":"dad","displayName":"Dad","role":"member"}}"""
            )
        )
        val resp = api.login("dad", "hunter22")
        assertEquals("sess-123", resp.token)
        assertEquals("Dad", resp.user.displayName)
        val recorded = server.takeRequest()
        assertEquals("/auth/login", recorded.path)
        assertTrue(recorded.body.readUtf8().contains("hunter22"))
    }

    @Test
    fun `a 401 surfaces as UnauthorizedException`() = runBlocking {
        api.authToken = "stale"
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"Not signed in."}"""))
        try {
            api.listTasks()
            org.junit.Assert.fail("expected UnauthorizedException")
        } catch (e: UnauthorizedException) {
            assertTrue(e.message!!.isNotBlank())
        }
    }

    @Test
    fun `requests carry the bearer token once set`() = runBlocking {
        api.authToken = "tok-xyz"
        server.enqueue(MockResponse().setBody("""{"tasks":[]}"""))
        api.listTasks()
        assertEquals("Bearer tok-xyz", server.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun `me parses the current user`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"user":{"id":"U1","username":"mom","displayName":"Mom","role":"admin"}}"""))
        assertEquals("admin", api.me().role)
    }

    @Test
    fun `documents response decodes extraction fields`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"documents":[{"id":"DOC12345","filename":"bill.txt","rawText":"hi","extracted":{"summary":"A bill","category":"bill","importantDates":["2026-10-01"]},"createdAt":"2026-09-01T00:00:00.000Z"}]}"""
            )
        )
        val docs = api.listDocuments()
        assertEquals("bill", docs[0].extracted?.category)
        assertEquals(listOf("2026-10-01"), docs[0].extracted?.importantDates)
    }
}
