export async function saveTrade(trade) {
  try {
    const response = await fetch("/api/trades", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify(trade),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data?.message ||
        data?.error ||
        "Kunde inte spara traden"
      );
    }

    return {
      success: true,
      trade: data.trade,
    };
  } catch (error) {
    console.error("Trade logger error:", error);

    return {
      success: false,
      error: error.message || "Okänt fel",
    };
  }
}
