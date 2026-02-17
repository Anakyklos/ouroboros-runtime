from playwright.sync_api import sync_playwright

def run(playwright):
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_viewport_size({"width": 1280, "height": 800})

    # Navigate to the Mission Control page (assuming dev server is running on port 3000)
    page.goto("http://localhost:3000")

    # Wait for the main elements to load
    page.wait_for_selector("text=OUROBOROS")
    page.wait_for_selector("text=Mission Control")

    # Verify the grid layout
    page.wait_for_selector("text=THE EYE")
    page.wait_for_selector("text=THE COIL")

    # Take a screenshot of the Desktop layout
    page.screenshot(path="verification/mission_control_desktop.png")

    # Test Mobile Layout
    page.set_viewport_size({"width": 375, "height": 667})
    page.reload()
    page.wait_for_selector("text=OUROBOROS")
    page.screenshot(path="verification/mission_control_mobile.png")

    browser.close()

with sync_playwright() as playwright:
    run(playwright)
