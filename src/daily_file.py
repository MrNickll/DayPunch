# PunchTrak daily_file.py
import os
import glob
import shutil
from datetime import date
from openpyxl import load_workbook, Workbook

from config import FOLDER, PUNCH_SHEET, PUNCH_ROWS, DATA_COLS, LAST_PUNCH_ROW

COLUMNS = ["Date", "Time", "Status", "Job", "Line", "Duration", "OP-Code",
           "Odometer", "W", "Ticket", "Description", "Story",
           "Copy Text", "DateText", "TimeText"]


def row_formulas(ws, row):
    """The derived columns for one punch row. Kept here so a blank template and
    a saved sheet are built the same way."""
    r, nr = row, row + 1
    if r > 2:
        ws.cell(r, 1).value = "=$A$2"
    ws.cell(r, 6).value = f"=MAX(0,SUM(B{nr}-B{r})*24)"
    ws.cell(r, 12).value = "-"
    ws.cell(r, 13).value = (
        f'=IF(I{r}="x",(_xlfn.CONCAT(J{r}," ","- ",N{r},", ",O{r}," - ",C{r},", ",G{r}," - ",K{r},": ",L{r})),'
        f'(_xlfn.CONCAT(J{r}," ","- ",N{r},", ",O{r}," - ",C{r},", ",K{r},": ",L{r})))'
    )
    ws.cell(r, 14).value = f'=TEXT(A{r},"mm/dd/yyyy")'
    ws.cell(r, 15).value = f'=TEXT(B{r},"hh:mm")'


def build_blank_workbook(path, day=None):
    """Create a day sheet from scratch.

    A fresh install has no previous file to copy, so there has to be a template
    in the code rather than an assumption that one already exists on disk.
    """
    wb = Workbook()
    ws = wb.active
    ws.title = PUNCH_SHEET
    for col, name in enumerate(COLUMNS, start=1):
        ws.cell(1, col).value = name
    ws.cell(2, 1).value = day or date.today()
    ws.cell(2, 1).number_format = "yyyy-mm-dd"
    for row in PUNCH_ROWS:
        row_formulas(ws, row)
        ws.cell(row, 2).number_format = "h:mm;@"
        ws.cell(row, 6).number_format = "0.00"
    ws.column_dimensions["K"].width = 34
    ws.column_dimensions["L"].width = 46
    os.makedirs(os.path.dirname(path), exist_ok=True)
    wb.save(path)
    wb.close()
    return path


def find_most_recent_file():
    """Return the most recent YYYY-MM-DD.xlsx, regardless of whether it's today's."""
    files = sorted(glob.glob(os.path.join(FOLDER, "????-??-??.xlsx")))
    return files[-1] if files else None


def clear_punch_times(ws):
    """
    Clear all punch data from the Punch Times sheet.
    Clears cols B, C, D, E, H, I, J, K, L (rows 2–30).
    Preserves col A (date formula), F (duration), G (OP-code lookup), M/N/O (summary formulas).
    Resets col L to '-' placeholder.
    Sets A2 to today's date.
    """
    for row in PUNCH_ROWS:
        for col in DATA_COLS:
            ws.cell(row=row, column=col).value = None
        ws.cell(row=row, column=12).value = "-"   # story placeholder

    ws["A2"] = date.today()


def create_daily_file():
    """
    Create today's YYYY-MM-DD.xlsx if it doesn't already exist.
    Copies the most recent dated file and clears punch data.
    Does nothing if today's file already exists.
    """
    today_str = date.today().strftime("%Y-%m-%d")
    new_path  = os.path.join(FOLDER, f"{today_str}.xlsx")

    if os.path.exists(new_path):
        return  # Already exists — nothing to do

    source = find_most_recent_file()
    if not source:
        # First ever run: nothing to carry forward, so start from the template.
        return build_blank_workbook(new_path)

    shutil.copy2(source, new_path)

    wb = load_workbook(new_path)
    ws = wb[PUNCH_SHEET]
    clear_punch_times(ws)
    wb.save(new_path)
    wb.close()
