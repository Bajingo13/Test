// cv-script.js

document.addEventListener("DOMContentLoaded", function () {
  const btnAdd = document.getElementById("btnAdd");
  const btnCancel = document.getElementById("btnCancel");
  const btnEdit = document.getElementById("btnEdit");

  const toggleFields = (shouldEnable) => {
    const elements = document.querySelectorAll("input, select, textarea");
    elements.forEach(el => {
      if (shouldEnable) {
        el.removeAttribute("disabled");
      } else {
        el.setAttribute("disabled", true);
      }
    });
  };

 // for button add the system will ask for confirmation
  btnAdd.addEventListener("click", function () {
    // Create overlay
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.top = 0;
    overlay.style.left = 0;
    overlay.style.width = "100vw";
    overlay.style.height = "100vh";
    overlay.style.background = "rgba(0,0,0,0.4)";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.zIndex = 1000;

    // Create dialog
    const dialog = document.createElement("div");
    dialog.style.background = "#fff";
    dialog.style.padding = "50px 50px";
    dialog.style.borderRadius = "10px";
    dialog.style.boxShadow = "0 2px 16px rgba(0,0,0,0.2)";
    dialog.style.textAlign = "center";

    const message = document.createElement("div");
    message.textContent = "Add Record?";
    message.style.fontSize = "1.2rem";
    message.style.marginBottom = "30px";

    const btnYes = document.createElement("button");
    btnYes.textContent = "Yes";
    btnYes.style.marginRight = "30px";
    btnYes.style.fontSize = "1.2rem";
    btnYes.style.padding = "5px 8px";

    const btnNo = document.createElement("button");
    btnNo.textContent = "No";
    btnNo.style.fontSize = "1.2rem";
    btnNo.style.padding = "5px 10px";

    dialog.appendChild(message);
    dialog.appendChild(btnYes);
    dialog.appendChild(btnNo);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    btnYes.addEventListener("click", function () {
      toggleFields(true);
      document.body.removeChild(overlay);
    });

    btnNo.addEventListener("click", function () {
      document.body.removeChild(overlay);
    });
  });

  // for button Edit the system will ask for confirmation
  btnEdit.addEventListener("click", function () {
    // Create overlay
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.top = 0;
    overlay.style.left = 0;
    overlay.style.width = "100vw";
    overlay.style.height = "100vh";
    overlay.style.background = "rgba(0,0,0,0.4)";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.zIndex = 1000;

    // Create dialog
    const dialog = document.createElement("div");
    dialog.style.background = "#fff";
    dialog.style.padding = "50px 50px";
    dialog.style.borderRadius = "10px";
    dialog.style.boxShadow = "0 2px 16px rgba(0,0,0,0.2)";
    dialog.style.textAlign = "center";

    const message = document.createElement("div");
    message.textContent = "Edit Record?";
    message.style.fontSize = "1.2rem";
    message.style.marginBottom = "30px";

    const btnYes = document.createElement("button");
    btnYes.textContent = "Yes";
    btnYes.style.marginRight = "30px";
    btnYes.style.fontSize = "1.2rem";
    btnYes.style.padding = "5px 8px";

    const btnNo = document.createElement("button");
    btnNo.textContent = "No";
    btnNo.style.fontSize = "1.2rem";
    btnNo.style.padding = "5px 10px";

    dialog.appendChild(message);
    dialog.appendChild(btnYes);
    dialog.appendChild(btnNo);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    btnYes.addEventListener("click", function () {
      toggleFields(true);
      document.body.removeChild(overlay);
    });

    btnNo.addEventListener("click", function () {
      document.body.removeChild(overlay);
    });
  });

  

  // for button Cancel the system will ask for confirmation
    btnCancel.addEventListener("click", function () {
    // Create overlay
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.top = 0;
    overlay.style.left = 0;
    overlay.style.width = "100vw";
    overlay.style.height = "100vh";
    overlay.style.background = "rgba(0,0,0,0.4)";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.zIndex = 1000;

    // Create dialog
    const dialog = document.createElement("div");
    dialog.style.background = "#fff";
    dialog.style.padding = "50px 50px";
    dialog.style.borderRadius = "10px";
    dialog.style.boxShadow = "0 2px 16px rgba(0,0,0,0.2)";
    dialog.style.textAlign = "center";

    const message = document.createElement("div");
    message.textContent = "Are you sure you want to add a new entry?";
    message.style.fontSize = "1.2rem";
    message.style.marginBottom = "30px";

    const btnYes = document.createElement("button");
    btnYes.textContent = "Yes";
    btnYes.style.marginRight = "30px";
    btnYes.style.fontSize = "1.2rem";
    btnYes.style.padding = "5px 8px";

    const btnNo = document.createElement("button");
    btnNo.textContent = "No";
    btnNo.style.fontSize = "1.2rem";
    btnNo.style.padding = "5px 10px";

    dialog.appendChild(message);
    dialog.appendChild(btnYes);
    dialog.appendChild(btnNo);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    btnYes.addEventListener("click", function () {
      toggleFields(false);
      document.body.removeChild(overlay);
    });

    btnNo.addEventListener("click", function () {
      document.body.removeChild(overlay);
    });
  });
  });


  