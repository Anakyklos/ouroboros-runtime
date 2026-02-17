from playwright.sync_api import sync_playwright

def run(playwright):
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_viewport_size({"width": 1920, "height": 1080})

    print("Navigating...")
    page.goto("http://localhost:3000")
    page.wait_for_selector("text=OUROBOROS")

    print("Clicking toggle...")
    page.click("button[title='Toggle Swiss Theme']")

    print("Waiting for Swiss UI...")
    # This button only exists in Swiss mode
    page.wait_for_selector("text=Switch to Cyberpunk", timeout=10000)

    print("Success!")
    page.screenshot(path="verification/swiss_dashboard.png", full_page=True)
    browser.close()

if __name__ == "__main__":
    with sync_playwright() as playwright:
        run(playwright)
